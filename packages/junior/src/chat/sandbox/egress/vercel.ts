import { resolveBaseUrl } from "@/chat/oauth-flow";
import { logWarn } from "@/chat/logging";
import { verifyVercelSandboxOidcToken } from "@/chat/sandbox/egress/oidc";
import {
  executeSandboxEgressRequest,
  redactSandboxEgressProxyPath,
  sandboxEgressAttributes,
  sandboxEgressRoutingAttributes,
  type SandboxEgressProxyDeps,
} from "@/chat/sandbox/egress/proxy";
import { SANDBOX_EGRESS_PROXY_PATH } from "@/chat/sandbox/egress/session";
import type { SandboxNetworkPolicy } from "@/chat/sandbox/workspace";
import type { JWTPayload } from "jose";

// Module overview: Vercel Sandbox egress.
//
// Outbound: turn Junior's provider-neutral network policy into Vercel network
// rules. Credentialed domains get a `forwardURL` that points back to Junior's
// egress route, with the signed credential token in the path.
//
// Inbound: Vercel's network layer forwards those requests to that route. It
// adds an OIDC token that names the sandbox VM, and `vercel-forwarded-*`
// headers that describe the original upstream URL. This module verifies the
// token, rebuilds the URL, and hands the request to the shared
// `executeSandboxEgressRequest`.

const OIDC_TOKEN_HEADER = "vercel-sandbox-oidc-token";
const FORWARDED_HOST_HEADER = "vercel-forwarded-host";
const FORWARDED_SCHEME_HEADER = "vercel-forwarded-scheme";
const FORWARDED_PORT_HEADER = "vercel-forwarded-port";
const FORWARDED_PATH_HEADER = "vercel-forwarded-path";

/** One outbound rule for a domain in a Vercel Sandbox network policy. */
type VercelSandboxNetworkRule =
  | { forwardURL: string }
  | { transform: Array<{ headers: Record<string, string> }> };

/** The Vercel Sandbox network policy shape that Junior uses. */
type VercelSandboxNetworkPolicy =
  | "allow-all"
  | { allow: Record<string, VercelSandboxNetworkRule[]> };

/** Runtime dependencies for the Vercel side of the sandbox egress proxy. */
export interface VercelSandboxEgressProxyDeps extends SandboxEgressProxyDeps {
  verifyOidc?: (token: string) => Promise<JWTPayload>;
}

type UpstreamUrlResult = { ok: true; url: URL } | { ok: false; error: string };
type UpstreamPathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function forwardUrl(credentialToken: string): string {
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "Cannot determine base URL for sandbox credential egress (set JUNIOR_BASE_URL or deploy to Vercel)",
    );
  }
  return new URL(
    `${SANDBOX_EGRESS_PROXY_PATH}/${credentialToken}`,
    baseUrl,
  ).toString();
}

/**
 * Turn Junior's network policy into Vercel Sandbox network rules.
 *
 * Every other domain stays open through the `*` rule. Credentialed domains
 * forward to Junior's egress route, and trace domains get a header transform.
 */
export function toVercelNetworkPolicy(
  policy: SandboxNetworkPolicy,
): VercelSandboxNetworkPolicy {
  if (policy === "allow-all") {
    return policy;
  }
  const rules = new Map<string, VercelSandboxNetworkRule[]>();
  const credentialEgress = policy.credentialEgress;
  if (credentialEgress && credentialEgress.domains.length > 0) {
    const forwardURL = forwardUrl(credentialEgress.credentialToken);
    for (const domain of credentialEgress.domains) {
      rules.set(domain, [{ forwardURL }]);
    }
  }
  const traceHeaders = policy.traceHeaders;
  if (traceHeaders) {
    for (const domain of traceHeaders.domains) {
      rules.set(domain, [{ transform: [{ headers: traceHeaders.headers }] }]);
    }
  }
  return {
    allow: {
      "*": [],
      ...Object.fromEntries(
        [...rules.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    },
  };
}

/** Read the signed credential token from the forward URL path. */
function credentialTokenFromRequest(request: Request): string | undefined {
  const pathname = new URL(request.url).pathname;
  const prefix = `${SANDBOX_EGRESS_PROXY_PATH}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const token = pathname.slice(prefix.length).split("/")[0];
  if (!token) {
    return undefined;
  }
  try {
    return decodeURIComponent(token);
  } catch {
    return undefined;
  }
}

function normalizeHost(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes(":")
  ) {
    return undefined;
  }
  return trimmed.replace(/\.$/, "");
}

function normalizeScheme(value: string): "https" | undefined {
  return value.trim().toLowerCase() === "https" ? "https" : undefined;
}

function normalizePort(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d{1,5}$/.test(trimmed)) {
    return undefined;
  }
  const port = Number.parseInt(trimmed, 10);
  return port >= 1 && port <= 65_535 ? trimmed : undefined;
}

function sandboxIdFromPayload(payload: JWTPayload): string | undefined {
  return typeof payload.sandbox_id === "string"
    ? payload.sandbox_id
    : undefined;
}

function normalizedForwardedPath(path: string): UpstreamPathResult {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("#") ||
    /[\r\n]/.test(path)
  ) {
    return { ok: false, error: "Invalid forwarded path" };
  }
  try {
    const url = new URL(path, "https://sandbox-forwarded.local");
    return { ok: true, path: `${url.pathname}${url.search}` };
  } catch {
    return { ok: false, error: "Invalid forwarded path" };
  }
}

function upstreamPath(request: Request): UpstreamPathResult {
  const forwardedPath = request.headers.get(FORWARDED_PATH_HEADER);
  if (!forwardedPath?.trim()) {
    return { ok: false, error: "Missing forwarded path" };
  }

  // Vercel may normalize request.url; this header carries the original target.
  return normalizedForwardedPath(forwardedPath.trim());
}

/**
 * Rebuild the HTTPS upstream URL from Vercel forwarding headers.
 *
 * This is the proxy's wire-format boundary for forwarded requests: host, path,
 * scheme, and port must normalize before the request can reach provider egress.
 */
function buildUpstreamUrl(request: Request): UpstreamUrlResult {
  const forwardedHost = request.headers.get(FORWARDED_HOST_HEADER);
  if (!forwardedHost?.trim()) {
    return { ok: false, error: "Missing forwarded host" };
  }
  const host = normalizeHost(forwardedHost);
  if (!host) {
    return { ok: false, error: "Invalid forwarded host" };
  }
  const forwardedScheme = request.headers.get(FORWARDED_SCHEME_HEADER);
  if (!forwardedScheme?.trim()) {
    return { ok: false, error: "Missing forwarded scheme" };
  }
  const scheme = normalizeScheme(forwardedScheme);
  if (!scheme) {
    return { ok: false, error: "Forwarded scheme must be https" };
  }
  const forwardedPort = request.headers.get(FORWARDED_PORT_HEADER);
  const port = normalizePort(forwardedPort);
  if (forwardedPort && !port) {
    return { ok: false, error: "Invalid forwarded port" };
  }
  const path = upstreamPath(request);
  if (!path.ok) {
    return { ok: false, error: path.error };
  }
  try {
    const url = new URL(
      `${scheme}://${host}${port ? `:${port}` : ""}${path.path}`,
    );
    return { ok: true, url };
  } catch {
    return { ok: false, error: "Invalid forwarded URL" };
  }
}

/**
 * Return whether a request carries the forwarding headers expected from Vercel.
 *
 * This is only a cheap classifier for routing into the proxy handler. Real
 * authentication happens in `proxyVercelSandboxEgressRequest`, which verifies
 * the OIDC token, and in `executeSandboxEgressRequest`, which verifies the
 * signed Junior credential context.
 */
export function isVercelSandboxEgressRequest(request: Request): boolean {
  return Boolean(
    request.headers.get(OIDC_TOKEN_HEADER)?.trim() &&
    request.headers.get(FORWARDED_HOST_HEADER)?.trim() &&
    request.headers.get(FORWARDED_SCHEME_HEADER)?.trim(),
  );
}

/**
 * Handle one sandbox egress request that Vercel's network layer forwarded.
 *
 * This is the Vercel side of the proxy boundary. It rejects requests without a
 * valid Vercel Sandbox OIDC token and rejects invalid forwarded URLs. Then it
 * hands the verified VM id, upstream URL, and credential token to the shared
 * `executeSandboxEgressRequest`.
 */
export async function proxyVercelSandboxEgressRequest(
  request: Request,
  deps: VercelSandboxEgressProxyDeps = {},
): Promise<Response> {
  const oidcToken = request.headers.get(OIDC_TOKEN_HEADER)?.trim();
  if (!oidcToken) {
    return jsonError("Missing Vercel Sandbox OIDC token", 401);
  }

  let oidcPayload: JWTPayload;
  try {
    oidcPayload = await (deps.verifyOidc ?? verifyVercelSandboxOidcToken)(
      oidcToken,
    );
  } catch (error) {
    logWarn("sandbox.egress.oidc_verification.failed", {
      "app.sandbox.oidc_error":
        error instanceof Error ? error.message : String(error),
    });
    return jsonError("Invalid Vercel Sandbox OIDC token", 401);
  }

  const activeEgressId = sandboxIdFromPayload(oidcPayload);
  if (!activeEgressId) {
    logWarn("sandbox.egress.oidc_session.missing", {
      "http.request.method": request.method,
      "url.path": redactSandboxEgressProxyPath(new URL(request.url).pathname),
    });
    return jsonError(
      "Vercel Sandbox OIDC token did not include sandbox_id",
      401,
    );
  }

  const upstreamResult = buildUpstreamUrl(request);
  if (!upstreamResult.ok) {
    logWarn("sandbox.egress.upstream_url.invalid", {
      ...sandboxEgressAttributes({
        egressId: activeEgressId,
        method: request.method,
        path: redactSandboxEgressProxyPath(new URL(request.url).pathname),
        status: 400,
      }),
      ...sandboxEgressRoutingAttributes(request),
    });
    return jsonError(upstreamResult.error, 400);
  }
  return await executeSandboxEgressRequest(
    {
      request,
      egressId: activeEgressId,
      upstreamUrl: upstreamResult.url,
      credentialToken: credentialTokenFromRequest(request),
    },
    deps,
  );
}
