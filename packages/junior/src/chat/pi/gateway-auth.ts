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

export type GatewayCredential = {
  mode: "oidc" | "api_key" | "none";
  token: string;
};

// Sent when no credential resolves. Model clients refuse to send a request
// without a key, so this lets the request reach the gateway. The gateway, or
// an egress proxy that injects real credentials, then decides on auth.
const UNAUTHENTICATED_GATEWAY_TOKEN = "unauthenticated";

/**
 * Resolve the AI Gateway bearer credential.
 *
 * Order:
 * 1. Vercel OIDC via `@vercel/oidc` (request header `x-vercel-oidc-token`,
 *    then `VERCEL_OIDC_TOKEN`, with local refresh when needed)
 * 2. Explicit `AI_GATEWAY_API_KEY` / pi-ai env mapping for vercel-ai-gateway
 * 3. A placeholder token (`mode: "none"`), so auth fails on the server side
 */
export async function resolveGatewayCredential(): Promise<GatewayCredential> {
  try {
    const oidcToken = toOptionalTrimmed(await getVercelOidcToken());
    if (oidcToken) {
      return { mode: "oidc", token: oidcToken };
    }
  } catch {
    // OIDC is optional outside Vercel runtime/build contexts. Missing header,
    // missing env, or local refresh failure should fall through to API key.
  }

  const apiKey = toOptionalTrimmed(getEnvApiKey("vercel-ai-gateway"));
  if (apiKey) {
    return { mode: "api_key", token: apiKey };
  }

  return { mode: "none", token: UNAUTHENTICATED_GATEWAY_TOKEN };
}

/** Resolve the bearer token string for Authorization headers and Pi getApiKey. */
export async function getGatewayApiKey(): Promise<string> {
  return (await resolveGatewayCredential()).token;
}
