import { toOptionalTrimmed } from "@/chat/optional-string";

const REQUEST_CONTEXT_SYMBOL = Symbol.for("@vercel/request-context");
const VERCEL_OIDC_HEADER = "x-vercel-oidc-token";

interface VercelRequestContext {
  headers?: Record<string, string>;
}

interface VercelRequestContextProvider {
  get?: () => VercelRequestContext | undefined;
}

function getVercelRequestContext(): VercelRequestContext | undefined {
  return (
    globalThis as typeof globalThis & {
      [REQUEST_CONTEXT_SYMBOL]?: VercelRequestContextProvider;
    }
  )[REQUEST_CONTEXT_SYMBOL]?.get?.();
}

/**
 * Resolve the ambient Vercel OIDC token from build env or request context.
 *
 * Vercel's own SDKs can read this implicitly, but our pi-ai/manual-fetch paths
 * still need the raw token string passed in explicitly.
 */
export function getAmbientVercelOidcToken(): string | undefined {
  return (
    toOptionalTrimmed(
      getVercelRequestContext()?.headers?.[VERCEL_OIDC_HEADER],
    ) ?? toOptionalTrimmed(process.env.VERCEL_OIDC_TOKEN)
  );
}
