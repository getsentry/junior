import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
} from "jose";

const OIDC_DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000;
const OIDC_DISCOVERY_CACHE_MAX_ENTRIES = 8;

interface OidcConfiguration {
  jwks_uri?: string;
}

interface OidcDiscoveryCacheEntry {
  jwks: ReturnType<typeof createRemoteJWKSet>;
  expiresAtMs: number;
}

const jwksByIssuer = new Map<string, OidcDiscoveryCacheEntry>();

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

  const response = await fetch(buildDiscoveryUrl(issuer), {
    redirect: "error",
  });
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

function expectedVercelOidcAudience(): string {
  const audience = process.env.VERCEL_OIDC_AUDIENCE?.trim();
  if (!audience) {
    throw new Error("VERCEL_OIDC_AUDIENCE is required for sandbox egress OIDC");
  }
  return audience;
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
  if (payload.sandbox_id !== sandboxId) {
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
  const audience = expectedVercelOidcAudience();
  const jwks = await getJwks(unverified.iss);
  const verified = await jwtVerify(token, jwks, {
    issuer: unverified.iss,
    audience,
  });
  validateVercelSandboxOidcClaims(verified.payload, sandboxId);
  return verified.payload;
}
