import { issueProviderCredentialLease } from "@/chat/capabilities/factory";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import { logWarn } from "@/chat/logging";
import {
  matchesSandboxEgressDomain,
  resolveSandboxEgressProviderForHost,
} from "@/chat/sandbox/egress-policy";
import { verifyVercelSandboxOidcToken } from "@/chat/sandbox/egress-oidc";
import {
  clearSandboxEgressCredentialLease,
  getSandboxEgressCredentialLease,
  getSandboxEgressSession,
  setSandboxEgressCredentialLease,
  type SandboxEgressCredentialLease,
  type SandboxEgressSession,
} from "@/chat/sandbox/egress-session";
import type { JWTPayload } from "jose";

const OIDC_TOKEN_HEADER = "vercel-sandbox-oidc-token";
const FORWARDED_HOST_HEADER = "vercel-forwarded-host";
const FORWARDED_SCHEME_HEADER = "vercel-forwarded-scheme";
const FORWARDED_PORT_HEADER = "vercel-forwarded-port";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const PROXY_ONLY_HEADERS = new Set([
  OIDC_TOKEN_HEADER,
  FORWARDED_HOST_HEADER,
  FORWARDED_SCHEME_HEADER,
  FORWARDED_PORT_HEADER,
]);
const DECODED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
]);
const AUTH_REJECTION_STATUS = new Set([401, 403]);
interface ProxyDeps {
  fetch?: typeof fetch;
  verifyOidc?: (token: string) => Promise<JWTPayload>;
}

type UpstreamUrlResult = { ok: true; url: URL } | { ok: false; error: string };

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
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

function upstreamPath(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

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
  try {
    const url = new URL(`${scheme}://${host}${port ? `:${port}` : ""}${path}`);
    return { ok: true, url };
  } catch {
    return { ok: false, error: "Invalid forwarded URL" };
  }
}

async function requestBodyBytes(
  request: Request,
): Promise<ArrayBuffer | undefined> {
  if (
    request.method === "GET" ||
    request.method === "HEAD" ||
    request.body === null
  ) {
    return undefined;
  }
  return await request.arrayBuffer();
}

function requestHeaders(
  request: Request,
  lease: SandboxEgressCredentialLease,
  upstreamHost: string,
): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      PROXY_ONLY_HEADERS.has(normalized)
    ) {
      return;
    }
    headers.append(key, value);
  });

  for (const transform of lease.headerTransforms) {
    if (!matchesSandboxEgressDomain(upstreamHost, transform.domain)) {
      continue;
    }
    for (const [key, value] of Object.entries(transform.headers)) {
      headers.set(key, value);
    }
  }
  return headers;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(normalized) &&
      !DECODED_RESPONSE_HEADERS.has(normalized)
    ) {
      headers.append(key, value);
    }
  });
  return headers;
}

async function credentialLease(
  egressId: string,
  provider: string,
  session: SandboxEgressSession,
): Promise<SandboxEgressCredentialLease> {
  const cached = await getSandboxEgressCredentialLease(
    egressId,
    provider,
    session,
  );
  if (cached) {
    return cached;
  }

  const lease = await issueProviderCredentialLease({
    provider,
    requesterId: session.requesterId,
    reason: `sandbox-egress:${provider}`,
  });
  const headerTransforms = lease.headerTransforms ?? [];
  if (headerTransforms.length === 0) {
    throw new Error(
      `Credential lease for ${provider} did not include header transforms`,
    );
  }

  const cachedLease: SandboxEgressCredentialLease = {
    provider,
    expiresAt: lease.expiresAt,
    headerTransforms,
  };
  await setSandboxEgressCredentialLease(egressId, session, cachedLease);
  return cachedLease;
}

function hasTransformForHost(
  lease: SandboxEgressCredentialLease,
  host: string,
): boolean {
  return lease.headerTransforms.some((transform) =>
    matchesSandboxEgressDomain(host, transform.domain),
  );
}

/** Return whether a request appears to be from the Vercel Sandbox egress proxy. */
export function isSandboxEgressForwardedRequest(request: Request): boolean {
  return Boolean(
    request.headers.get(OIDC_TOKEN_HEADER)?.trim() &&
    request.headers.get(FORWARDED_HOST_HEADER)?.trim() &&
    request.headers.get(FORWARDED_SCHEME_HEADER)?.trim(),
  );
}

/** Proxy one Vercel Sandbox firewall egress request through Junior credential activation. */
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
    return jsonError(
      "Vercel Sandbox OIDC token did not include sandbox_id",
      401,
    );
  }

  const upstreamResult = buildUpstreamUrl(request);
  if (!upstreamResult.ok) {
    return jsonError(upstreamResult.error, 400);
  }
  const upstreamUrl = upstreamResult.url;

  const provider = resolveSandboxEgressProviderForHost(upstreamUrl.hostname);
  if (!provider) {
    return jsonError("No provider owns forwarded host", 403);
  }

  // Vercel OIDC authenticates the forwarded VM session; Junior's egress
  // session authorizes credential activation for the current requester.
  const session = await getSandboxEgressSession(activeEgressId);
  if (!session) {
    return jsonError("Sandbox egress session is not authorized", 403);
  }

  let lease: SandboxEgressCredentialLease;
  try {
    lease = await credentialLease(activeEgressId, provider, session);
  } catch (error) {
    if (error instanceof CredentialUnavailableError) {
      return new Response(
        `junior-auth-required provider=${error.provider} 401 unauthorized\n${error.message}`,
        {
          status: 401,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }
    throw error;
  }

  if (!hasTransformForHost(lease, upstreamUrl.hostname)) {
    return jsonError("Credential lease does not cover forwarded host", 403);
  }

  const body = await requestBodyBytes(request);
  const upstream = await (deps.fetch ?? fetch)(upstreamUrl, {
    method: request.method,
    headers: requestHeaders(request, lease, upstreamUrl.hostname),
    ...(body ? { body } : {}),
    redirect: "manual",
  });
  if (AUTH_REJECTION_STATUS.has(upstream.status)) {
    logWarn(
      "sandbox_egress_upstream_auth_rejected",
      {},
      {
        "app.credential.provider": provider,
        "http.request.method": request.method,
        "http.response.status_code": upstream.status,
        "server.address": upstreamUrl.hostname,
      },
      "Sandbox egress upstream auth rejected",
    );
    await clearSandboxEgressCredentialLease(activeEgressId, provider, session);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream),
  });
}
