import { createHash } from "node:crypto";
import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { issueProviderCredentialLease } from "@/chat/capabilities/factory";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import {
  buildSandboxEgressNetworkPolicy,
  resolveSandboxEgressProviderForHost,
} from "@/chat/sandbox/egress-policy";
import {
  claimSandboxEgressReplayFingerprint,
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

interface OidcConfiguration {
  jwks_uri?: string;
}

interface ProxyDeps {
  fetch?: typeof fetch;
  verifyOidc?: (token: string, sandboxId: string) => Promise<JWTPayload>;
}

const jwksByUri = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function normalizeHost(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) {
    return undefined;
  }
  return trimmed.replace(/\.$/, "");
}

function normalizeScheme(value: string | null): "http" | "https" | undefined {
  if (value === "http" || value === "https") {
    return value;
  }
  return undefined;
}

function normalizePort(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return /^\d{1,5}$/.test(trimmed) ? trimmed : undefined;
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

async function getJwks(
  issuer: string,
): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const discoveryUrl = buildDiscoveryUrl(issuer);
  const response = await fetch(discoveryUrl);
  if (!response.ok) {
    throw new Error("Unable to load Vercel OIDC discovery metadata");
  }
  const config = (await response.json()) as OidcConfiguration;
  if (!config.jwks_uri) {
    throw new Error("Vercel OIDC discovery metadata did not include jwks_uri");
  }
  let jwks = jwksByUri.get(config.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(config.jwks_uri));
    jwksByUri.set(config.jwks_uri, jwks);
  }
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
): URL | undefined {
  const host = normalizeHost(request.headers.get(FORWARDED_HOST_HEADER) ?? "");
  if (!host) {
    return undefined;
  }
  const scheme =
    normalizeScheme(request.headers.get(FORWARDED_SCHEME_HEADER)) ?? "https";
  const port = normalizePort(request.headers.get(FORWARDED_PORT_HEADER));
  return new URL(
    `${scheme}://${host}${port ? `:${port}` : ""}${upstreamPath(request, sandboxId)}`,
  );
}

async function requestBodyBytes(
  request: Request,
): Promise<ArrayBuffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  return await request.arrayBuffer();
}

function bodyHash(body: ArrayBuffer | undefined): string {
  return createHash("sha256")
    .update(Buffer.from(body ?? new ArrayBuffer(0)))
    .digest("hex");
}

function oidcTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function replayFingerprint(input: {
  oidcToken: string;
  method: string;
  upstreamUrl: URL;
  body: ArrayBuffer | undefined;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        token: oidcTokenHash(input.oidcToken),
        method: input.method,
        url: input.upstreamUrl.toString(),
        body: bodyHash(input.body),
      }),
    )
    .digest("hex");
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
      normalized.startsWith("x-forwarded-")
    ) {
      return;
    }
    headers.set(key, value);
  });

  for (const transform of lease.headerTransforms) {
    if (transform.domain.toLowerCase() !== upstreamHost.toLowerCase()) {
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
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  return headers;
}

async function credentialLease(input: {
  sandboxId: string;
  provider: string;
  session: SandboxEgressSession;
}): Promise<SandboxEgressCredentialLease> {
  const cached = await getSandboxEgressCredentialLease({
    sandboxId: input.sandboxId,
    provider: input.provider,
  });
  if (cached) {
    return cached;
  }

  const lease = await issueProviderCredentialLease({
    provider: input.provider,
    requesterId: input.session.requesterId,
    reason: `sandbox-egress:${input.provider}`,
  });
  const headerTransforms = lease.headerTransforms ?? [];
  if (headerTransforms.length === 0) {
    throw new Error(
      `Credential lease for ${input.provider} did not include header transforms`,
    );
  }

  const cachedLease: SandboxEgressCredentialLease = {
    provider: input.provider,
    expiresAt: lease.expiresAt,
    headerTransforms,
  };
  await setSandboxEgressCredentialLease({
    sandboxId: input.sandboxId,
    lease: cachedLease,
    sessionExpiresAtMs: input.session.expiresAtMs,
  });
  return cachedLease;
}

function hasTransformForHost(
  lease: SandboxEgressCredentialLease,
  host: string,
): boolean {
  return lease.headerTransforms.some(
    (transform) => transform.domain.toLowerCase() === host.toLowerCase(),
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

  const upstreamUrl = buildUpstreamUrl(request, sandboxId);
  if (!upstreamUrl) {
    return jsonError("Missing forwarded host", 400);
  }

  const provider = resolveSandboxEgressProviderForHost(upstreamUrl.hostname);
  if (!provider) {
    return jsonError("No provider owns forwarded host", 403);
  }

  const session = await getSandboxEgressSession(sandboxId);
  if (!session || !session.providers.includes(provider)) {
    return jsonError("Sandbox egress session is not authorized", 403);
  }

  const body = await requestBodyBytes(request);
  const fingerprint = replayFingerprint({
    oidcToken,
    method: request.method,
    upstreamUrl,
    body,
  });
  if (!(await claimSandboxEgressReplayFingerprint(fingerprint))) {
    return jsonError("Duplicate sandbox egress request", 409);
  }

  let lease: SandboxEgressCredentialLease;
  try {
    lease = await credentialLease({ sandboxId, provider, session });
  } catch (error) {
    if (error instanceof CredentialUnavailableError) {
      return new Response(error.message, { status: 401 });
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
  if (!buildSandboxEgressNetworkPolicy(sandboxId)) {
    return jsonError("Sandbox egress proxy is not configured", 503);
  }
  return await proxySandboxEgressRequest(request, sandboxId);
}
