/**
 * AI Gateway credential resolution for every Junior model path.
 *
 * Prefer Vercel project OIDC so gateway usage attributes to the deploying
 * project. Fall back to AI_GATEWAY_API_KEY for local/CI and non-Vercel hosts.
 * Never cache resolved tokens: runtime OIDC rotates on each invocation.
 */
import { getVercelOidcToken } from "@vercel/oidc";
import { getEnvApiKey } from "@/chat/pi/sdk";
import { toOptionalTrimmed } from "@/chat/optional-string";

export type GatewayAuthMode = "oidc" | "api_key";

export type GatewayCredential = {
  mode: GatewayAuthMode;
  token: string;
};

export const MISSING_GATEWAY_CREDENTIALS_ERROR =
  "Missing AI gateway credentials (enable Vercel OIDC or set AI_GATEWAY_API_KEY)";

/**
 * Resolve the preferred AI Gateway bearer credential.
 *
 * Order:
 * 1. Vercel OIDC via `@vercel/oidc` (request header `x-vercel-oidc-token`,
 *    then `VERCEL_OIDC_TOKEN`, with local refresh when needed)
 * 2. Explicit `AI_GATEWAY_API_KEY` / pi-ai env mapping for vercel-ai-gateway
 */
export async function resolveGatewayCredential(): Promise<
  GatewayCredential | undefined
> {
  const oidcToken = await readVercelOidcToken();
  if (oidcToken) {
    return { mode: "oidc", token: oidcToken };
  }

  const apiKey = toOptionalTrimmed(getEnvApiKey("vercel-ai-gateway"));
  if (apiKey) {
    return { mode: "api_key", token: apiKey };
  }

  return undefined;
}

/**
 * Resolve the bearer token string for paths that need Authorization directly.
 * Prefer this over reading env vars at call sites.
 */
export async function getGatewayApiKey(): Promise<string | undefined> {
  const credential = await resolveGatewayCredential();
  return credential?.token;
}

/**
 * Resolve the bearer token for Pi Agent getApiKey hooks.
 * Always returns a Promise so callers can pass it through unchanged.
 */
export async function getPiGatewayApiKey(): Promise<string | undefined> {
  return getGatewayApiKey();
}

/** Read a live Vercel OIDC token, or undefined when OIDC is unavailable. */
async function readVercelOidcToken(): Promise<string | undefined> {
  try {
    return toOptionalTrimmed(await getVercelOidcToken());
  } catch {
    // OIDC is optional outside Vercel runtime/build contexts. Missing header,
    // missing env, or local refresh failure should fall through to API key.
    return undefined;
  }
}
