import { getAmbientVercelOidcToken } from "@/chat/configuration/vercel-oidc";
import { toOptionalTrimmed } from "@/chat/optional-string";

interface VercelSandboxCredentials {
  teamId: string;
  projectId: string;
  token: string;
}

/**
 * Resolve explicit Vercel Sandbox credentials, or return undefined to let
 * the SDK use its built-in OIDC resolution.
 */
export function getVercelSandboxCredentials():
  | VercelSandboxCredentials
  | undefined {
  const token = toOptionalTrimmed(process.env.VERCEL_TOKEN);
  const teamId = toOptionalTrimmed(process.env.VERCEL_TEAM_ID);
  const projectId = toOptionalTrimmed(process.env.VERCEL_PROJECT_ID);

  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }

  // Let the SDK resolve credentials whenever ambient Vercel OIDC is present.
  if (getAmbientVercelOidcToken()) {
    return undefined;
  }

  // If some — but not all — explicit vars are set and there's no OIDC fallback,
  // surface a clear error so the misconfiguration is obvious.
  if (token || teamId || projectId) {
    throw new Error(
      "Missing Vercel Sandbox credentials: set VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID together, or provide ambient Vercel OIDC.",
    );
  }

  return undefined;
}
