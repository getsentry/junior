import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { issueProviderCredentialLease } from "@/chat/capabilities/factory";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import {
  matchesSandboxEgressDomain,
  resolveSandboxEgressProviderForHost,
} from "@/chat/sandbox/egress-policy";
import {
  getSandboxEgressCredentialLease,
  getSandboxEgressSession,
  setSandboxEgressCredentialLease,
  type SandboxEgressCredentialLease,
  type SandboxEgressSession,
} from "@/chat/sandbox/egress-session";

const OIDC_TOKEN_HEADER = "vercel-sandbox-oidc-token";
const FORWARDED_HOST_HEADER = "vercel-forwarded-host";
const FORWARDED_SCHEME_HEADER = "vercel-forwarded-scheme";
const FORWARDED_PORT_HEADER = "vercel-forwarded-port";
const ROUTE_PREFIX = "/api/internal/sandbox-egress";
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
const SANDBOX_SUPPLIED_AUTH_HEADERS = new Set([
  "api-key",
  "authorization",
  "cookie",
  "private-token",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
]);
const UPSTREAM_CREDENTIAL_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "set-cookie2",
]);
const OIDC_DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000;
const OIDC_DISCOVERY_CACHE_MAX_ENTRIES = 8;

interface OidcConfiguration {
  jwks_uri?: string;
}

interface ProxyDeps {
  fetch?: typeof fetch;
  verifyOidc?: (token: string, sandboxId: string) => Promise<JWTPayload>;
}

interface OidcDiscoveryCacheEntry {
  jwks: ReturnType<typeof createRemoteJWKSet>;
  expiresAtMs: number;
}

type UpstreamUrlResult = { ok: true; url: URL } | { ok: false; error: string };

const jwksByIssuer = new Map<string, OidcDiscoveryCacheEntry>();

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

function normalizeScheme(value: string | null): "https" | undefined {
  if (!value) {
    return "https";
  }
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

function buildDiscoveryUrl(issuer: string): URL {
  const url = new URL(issuer);
  if (url.protocol !== "https:" || url.hostname !== "oidc.vercel.com") {
    throw new Error("Unexpected Vercel OIDC issuer");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`;
  url.search = "";
  url.hash = "";
  return url;
}

function buildJwksUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Vercel OIDC discovery jwks_uri must use HTTPS");
  }
  return url;
}

async function getJwks(
  issuer: string,
): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const now = Date.now();
  const cached = jwksByIssuer.get(issuer);
  if (cached && cached.expiresAtMs > now) {
    return cached.jwks;
  }
  if (cached) {
    jwksByIssuer.delete(issuer);
  }

  const discoveryUrl = buildDiscoveryUrl(issuer);
  const response = await fetch(discoveryUrl, { redirect: "error" });
  if (!response.ok) {
    throw new Error("Unable to load Vercel OIDC discovery metadata");
  }
  const config = (await response.json()) as OidcConfiguration;
  if (!config.jwks_uri) {
    throw new Error("Vercel OIDC discovery metadata did not include jwks_uri");
  }
  const jwks = createRemoteJWKSet(buildJwksUrl(config.jwks_uri));
  if (
    !jwksByIssuer.has(issuer) &&
    jwksByIssuer.size >= OIDC_DISCOVERY_CACHE_MAX_ENTRIES
  ) {
    const oldestIssuer = jwksByIssuer.keys().next().value;
    if (oldestIssuer) {
      jwksByIssuer.delete(oldestIssuer);
    }
  }
  jwksByIssuer.set(issuer, {
    jwks,
    expiresAtMs: now + OIDC_DISCOVERY_CACHE_TTL_MS,
  });
  return jwks;
}

function sandboxClaimMatches(payload: JWTPayload, sandboxId: string): boolean {
  for (const claim of [
    "sandbox_id",
    "sandboxId",
    "sandbox",
    "sandbox_name",
    "sandboxName",
    "name",
  ]) {
    if (payload[claim] === sandboxId) {
      return true;
    }
  }

  if (typeof payload.sub !== "string") {
    return false;
  }
  const parts = payload.sub.split(":");
  return parts.some(
    (part, index) => part === "sandbox" && parts[index + 1] === sandboxId,
  );
}

function expectedVercelOidcAudience(payload: JWTPayload): string {
  if (typeof payload.iss === "string") {
    const issuer = new URL(payload.iss);
    const teamSlug = issuer.pathname.split("/").filter(Boolean)[0];
    if (teamSlug) {
      return `https://vercel.com/${teamSlug}`;
    }
  }
  if (typeof payload.owner !== "string" || !payload.owner.trim()) {
    throw new Error("Vercel OIDC token did not include an owner");
  }
  return `https://vercel.com/${payload.owner.trim()}`;
}

/** Validate deployment and sandbox binding claims in a verified Vercel Sandbox OIDC payload. */
export function validateVercelSandboxOidcClaims(
  payload: JWTPayload,
  sandboxId: string,
): void {
  const expectedTeamId = process.env.VERCEL_TEAM_ID?.trim();
  const expectedProjectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (!expectedProjectId) {
    throw new Error("VERCEL_PROJECT_ID is required for sandbox egress OIDC");
  }
  if (
    expectedTeamId &&
    (typeof payload.owner_id !== "string" ||
      payload.owner_id !== expectedTeamId)
  ) {
    throw new Error("Vercel OIDC token belongs to a different team");
  }
  if (
    typeof payload.project_id !== "string" ||
    payload.project_id !== expectedProjectId
  ) {
    throw new Error("Vercel OIDC token belongs to a different project");
  }
  if (!sandboxClaimMatches(payload, sandboxId)) {
    throw new Error("Vercel OIDC token belongs to a different sandbox");
  }
}

/** Verify the Vercel-issued OIDC token attached to a sandbox firewall proxy request. */
export async function verifyVercelSandboxOidcToken(
  token: string,
  sandboxId: string,
): Promise<JWTPayload> {
  const unverified = decodeJwt(token);
  if (typeof unverified.iss !== "string") {
    throw new Error("Vercel OIDC token did not include an issuer");
  }
  const jwks = await getJwks(unverified.iss);
  const verified = await jwtVerify(token, jwks, {
    issuer: unverified.iss,
    audience: expectedVercelOidcAudience(unverified),
  });
  validateVercelSandboxOidcClaims(verified.payload, sandboxId);
  return verified.payload;
}

function upstreamPath(request: Request, sandboxId: string): string {
  const url = new URL(request.url);
  const prefix = `${ROUTE_PREFIX}/${encodeURIComponent(sandboxId)}`;
  if (url.pathname === prefix) {
    return `/${url.search}`;
  }
  if (url.pathname.startsWith(`${prefix}/`)) {
    return `${url.pathname.slice(prefix.length)}${url.search}`;
  }
  return `${url.pathname}${url.search}`;
}

function buildUpstreamUrl(
  request: Request,
  sandboxId: string,
): UpstreamUrlResult {
  const forwardedHost = request.headers.get(FORWARDED_HOST_HEADER);
  if (!forwardedHost?.trim()) {
    return { ok: false, error: "Missing forwarded host" };
  }
  const host = normalizeHost(forwardedHost);
  if (!host) {
    return { ok: false, error: "Invalid forwarded host" };
  }
  const scheme = normalizeScheme(request.headers.get(FORWARDED_SCHEME_HEADER));
  if (!scheme) {
    return { ok: false, error: "Forwarded scheme must be https" };
  }
  const forwardedPort = request.headers.get(FORWARDED_PORT_HEADER);
  const port = normalizePort(forwardedPort);
  if (forwardedPort && !port) {
    return { ok: false, error: "Invalid forwarded port" };
  }
  try {
    const url = new URL(
      `${scheme}://${host}${port ? `:${port}` : ""}${upstreamPath(request, sandboxId)}`,
    );
    return { ok: true, url };
  } catch {
    return { ok: false, error: "Invalid forwarded URL" };
  }
}

async function requestBodyBytes(
  request: Request,
): Promise<ArrayBuffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
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
      PROXY_ONLY_HEADERS.has(normalized) ||
      SANDBOX_SUPPLIED_AUTH_HEADERS.has(normalized) ||
      normalized.startsWith("x-forwarded-")
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
      !UPSTREAM_CREDENTIAL_RESPONSE_HEADERS.has(normalized)
    ) {
      headers.append(key, value);
    }
  });
  return headers;
}

async function credentialLease(
  sandboxId: string,
  provider: string,
  session: SandboxEgressSession,
): Promise<SandboxEgressCredentialLease> {
  const cached = await getSandboxEgressCredentialLease(
    sandboxId,
    provider,
    session.requesterId,
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
  await setSandboxEgressCredentialLease(
    sandboxId,
    session.requesterId,
    cachedLease,
    session.expiresAtMs,
  );
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

/** Proxy one Vercel Sandbox firewall egress request through Junior credential activation. */
export async function proxySandboxEgressRequest(
  request: Request,
  sandboxId: string,
  deps: ProxyDeps = {},
): Promise<Response> {
  const oidcToken = request.headers.get(OIDC_TOKEN_HEADER)?.trim();
  if (!oidcToken) {
    return jsonError("Missing Vercel Sandbox OIDC token", 401);
  }

  try {
    await (deps.verifyOidc ?? verifyVercelSandboxOidcToken)(
      oidcToken,
      sandboxId,
    );
  } catch {
    return jsonError("Invalid Vercel Sandbox OIDC token", 401);
  }

  const upstreamResult = buildUpstreamUrl(request, sandboxId);
  if (!upstreamResult.ok) {
    return jsonError(upstreamResult.error, 400);
  }
  const upstreamUrl = upstreamResult.url;

  const provider = resolveSandboxEgressProviderForHost(upstreamUrl.hostname);
  if (!provider) {
    return jsonError("No provider owns forwarded host", 403);
  }

  const session = await getSandboxEgressSession(sandboxId);
  if (!session || !session.providers.includes(provider)) {
    return jsonError("Sandbox egress session is not authorized", 403);
  }

  const body = await requestBodyBytes(request);
  let lease: SandboxEgressCredentialLease;
  try {
    lease = await credentialLease(sandboxId, provider, session);
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

  const upstream = await (deps.fetch ?? fetch)(upstreamUrl, {
    method: request.method,
    headers: requestHeaders(request, lease, upstreamUrl.hostname),
    ...(body ? { body } : {}),
    redirect: "manual",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream),
  });
}

/** Handles Vercel Sandbox firewall egress proxy requests. */
export async function ALL(
  request: Request,
  sandboxId: string,
): Promise<Response> {
  return await proxySandboxEgressRequest(request, sandboxId);
}
