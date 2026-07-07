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

/** Verify Vercel signed this Sandbox firewall proxy request for the active VM session. */
export async function verifyVercelSandboxOidcToken(
  token: string,
): Promise<JWTPayload> {
  const unverified = decodeJwt(token);
  if (typeof unverified.iss !== "string") {
    throw new Error("Vercel OIDC token did not include an issuer");
  }
  const jwks = await getJwks(unverified.iss);
  const verified = await jwtVerify(token, jwks, {
    issuer: unverified.iss,
  });
  // The Sandbox proxy token is request identity. Do not compare its audience,
  // team, or project claims with deployment OIDC; the signed actor
  // context decides which actor credentials may be issued lazily.
  return verified.payload;
}
