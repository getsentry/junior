import { logWarn, withSpan } from "@/chat/logging";
import {
  executeCredentialedEgressRequest,
  type CredentialedEgressHttpInterceptor,
} from "@/chat/sandbox/egress/execute";
import { resolveSandboxEgressProviderForHost } from "@/chat/sandbox/egress/policy";
import { verifyVercelSandboxOidcToken } from "@/chat/sandbox/egress/oidc";
import {
  parseSandboxEgressCredentialToken,
  SANDBOX_EGRESS_PROXY_PATH,
} from "@/chat/sandbox/egress/session";
import {
  shouldPropagateSandboxEgressTrace,
  type SandboxEgressTracePropagationConfig,
} from "@/chat/sandbox/egress/tracing";
import type { JWTPayload } from "jose";
import * as Sentry from "@/chat/sentry";

// Module overview: verify and route requests emitted by Vercel Sandbox
// network-policy forwarding.
//
// The sandbox VM is allowed to make outbound requests only through Vercel's
// firewall policy. For credentialed provider domains, Vercel forwards those
// requests here with an OIDC token and forwarding headers that describe the
// original upstream URL. This module authenticates the VM, rebuilds that URL,
// checks the signed Junior credential context bound to the VM id, and then
// hands the trusted provider request to `execute.ts`.

const OIDC_TOKEN_HEADER = "vercel-sandbox-oidc-token";
const FORWARDED_HOST_HEADER = "vercel-forwarded-host";
const FORWARDED_SCHEME_HEADER = "vercel-forwarded-scheme";
const FORWARDED_PORT_HEADER = "vercel-forwarded-port";
const FORWARDED_PATH_HEADER = "vercel-forwarded-path";
/**
 * Intercepts a verified sandbox HTTP request before live provider forwarding.
 *
 * The hook runs after OIDC, forwarded URL validation, provider ownership, and
 * credential-context checks have succeeded.
 */
export type SandboxEgressHttpInterceptor = CredentialedEgressHttpInterceptor;

/** Runtime dependencies for the sandbox egress proxy boundary. */
interface ProxyDeps {
  fetch?: typeof fetch;
  interceptHttp?: SandboxEgressHttpInterceptor;
  tracePropagation?: SandboxEgressTracePropagationConfig;
  verifyOidc?: (token: string) => Promise<JWTPayload>;
}

type UpstreamUrlResult = { ok: true; url: URL } | { ok: false; error: string };
type UpstreamPathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function egressAttributes(input: {
  egressId?: string;
  host?: string;
  method?: string;
  path?: string;
  provider?: string;
  status?: number;
}): Record<string, unknown> {
  return {
    ...(input.egressId ? { "app.sandbox.egress_id": input.egressId } : {}),
    ...(input.provider ? { "app.provider.name": input.provider } : {}),
    ...(input.host ? { "server.address": input.host } : {}),
    ...(input.method ? { "http.request.method": input.method } : {}),
    ...(input.path ? { "url.path": input.path } : {}),
    ...(input.status ? { "http.response.status_code": input.status } : {}),
  };
}

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

function redactedProxyPath(pathname: string): string {
  if (pathname.startsWith(`${SANDBOX_EGRESS_PROXY_PATH}/`)) {
    return `${SANDBOX_EGRESS_PROXY_PATH}/<token>`;
  }
  return pathname;
}

function routingAttributes(
  request: Request,
  upstreamUrl?: URL,
): Record<string, unknown> {
  const proxyUrl = new URL(request.url);
  const attributes: Record<string, unknown> = {
    "app.sandbox.egress.proxy_path": redactedProxyPath(proxyUrl.pathname),
  };
  if (upstreamUrl) {
    attributes["app.sandbox.egress.upstream_path"] = upstreamUrl.pathname;
    const gitService = upstreamUrl.searchParams.get("service");
    if (
      upstreamUrl.hostname.toLowerCase() === "github.com" &&
      (gitService === "git-upload-pack" || gitService === "git-receive-pack")
    ) {
      attributes["app.sandbox.egress.git_service"] = gitService;
    }
  }
  return attributes;
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

/** Continue inbound trace context only after sandbox egress verification succeeds. */
function continueSandboxEgressTrace<T>(
  request: Request,
  upstreamHost: string,
  tracePropagation: SandboxEgressTracePropagationConfig,
  callback: () => Promise<T>,
): Promise<T> {
  const sentryTrace = request.headers.get("sentry-trace") ?? undefined;
  const baggage = request.headers.get("baggage") ?? undefined;
  const run = () =>
    withSpan("sandbox.egress", "http.server", {}, callback, {
      "http.request.method": request.method,
      "url.path": redactedProxyPath(new URL(request.url).pathname),
    });
  if (
    !shouldPropagateSandboxEgressTrace(upstreamHost, tracePropagation) ||
    (!sentryTrace && !baggage)
  ) {
    return run();
  }
  return Sentry.continueTrace({ sentryTrace, baggage }, run);
}

/**
 * Return whether a request carries the forwarding headers expected from Vercel.
 *
 * This is only a cheap classifier for routing into the proxy handler. Real
 * authentication happens in `proxySandboxEgressRequest` by verifying the OIDC
 * token and signed Junior credential context.
 */
export function isSandboxEgressForwardedRequest(request: Request): boolean {
  return Boolean(
    request.headers.get(OIDC_TOKEN_HEADER)?.trim() &&
    request.headers.get(FORWARDED_HOST_HEADER)?.trim() &&
    request.headers.get(FORWARDED_SCHEME_HEADER)?.trim(),
  );
}

/**
 * Handle one forwarded sandbox egress request.
 *
 * This is the public proxy boundary: it rejects unauthenticated VM requests,
 * rejects forwarded URLs outside plugin-owned provider domains, rejects signed
 * credential contexts that do not match the active VM id, and only then asks
 * `execute.ts` to issue credentials and contact the upstream provider.
 */
export async function proxySandboxEgressRequest(
  request: Request,
  deps: ProxyDeps = {},
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
    logWarn(
      "sandbox_egress_oidc_verification_failed",
      {},
      {
        "app.sandbox.oidc_error":
          error instanceof Error ? error.message : String(error),
      },
      "Sandbox egress OIDC verification failed",
    );
    return jsonError("Invalid Vercel Sandbox OIDC token", 401);
  }

  const activeEgressId = sandboxIdFromPayload(oidcPayload);
  if (!activeEgressId) {
    logWarn(
      "sandbox_egress_oidc_session_missing",
      {},
      {
        "http.request.method": request.method,
        "url.path": redactedProxyPath(new URL(request.url).pathname),
      },
      "Sandbox egress OIDC payload did not include a VM session id",
    );
    return jsonError(
      "Vercel Sandbox OIDC token did not include sandbox_id",
      401,
    );
  }

  const upstreamResult = buildUpstreamUrl(request);
  if (!upstreamResult.ok) {
    logWarn(
      "sandbox_egress_upstream_url_invalid",
      {},
      {
        ...egressAttributes({
          egressId: activeEgressId,
          method: request.method,
          path: redactedProxyPath(new URL(request.url).pathname),
          status: 400,
        }),
        ...routingAttributes(request),
      },
      "Sandbox egress forwarded request had invalid upstream routing headers",
    );
    return jsonError(upstreamResult.error, 400);
  }
  const upstreamUrl = upstreamResult.url;

  const provider = resolveSandboxEgressProviderForHost(upstreamUrl.hostname);
  if (!provider) {
    logWarn(
      "sandbox_egress_provider_unresolved",
      {},
      {
        ...egressAttributes({
          egressId: activeEgressId,
          host: upstreamUrl.hostname,
          method: request.method,
          path: upstreamUrl.pathname,
          status: 403,
        }),
        ...routingAttributes(request, upstreamUrl),
      },
      "Sandbox egress forwarded host is not owned by any credential provider",
    );
    return jsonError("No provider owns forwarded host", 403);
  }

  // Vercel OIDC authenticates the forwarded VM session; Junior's signed
  // credential context identifies which provider credentials may be issued
  // lazily for that session.
  const credentialContext = parseSandboxEgressCredentialToken(
    credentialTokenFromRequest(request),
  );
  if (!credentialContext || credentialContext.egressId !== activeEgressId) {
    logWarn(
      "sandbox_egress_credential_context_unauthorized",
      {},
      {
        ...egressAttributes({
          egressId: activeEgressId,
          host: upstreamUrl.hostname,
          method: request.method,
          path: upstreamUrl.pathname,
          provider,
          status: 403,
        }),
        ...routingAttributes(request, upstreamUrl),
      },
      "Sandbox egress request did not include a valid credential context for the VM session",
    );
    return jsonError(
      "Sandbox egress credential context is not authorized",
      403,
    );
  }

  return await continueSandboxEgressTrace(
    request,
    upstreamUrl.hostname,
    deps.tracePropagation ?? {},
    async () =>
      await executeCredentialedEgressRequest({
        activeEgressId,
        credentialContext,
        deps,
        provider,
        request,
        upstreamUrl,
      }),
  );
}
