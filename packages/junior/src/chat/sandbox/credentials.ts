interface VercelSandboxCredentials {
  teamId: string;
  projectId: string;
  token: string;
}

function toOptionalTrimmed(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve explicit Vercel Sandbox credentials, or return undefined to let
 * the SDK use its built-in OIDC resolution (reads VERCEL_OIDC_TOKEN).
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

  // When the explicit triple is incomplete, let the SDK resolve credentials
  // via VERCEL_OIDC_TOKEN (extracts teamId/projectId from the JWT payload).
  if (toOptionalTrimmed(process.env.VERCEL_OIDC_TOKEN)) {
    return undefined;
  }

  // If some — but not all — explicit vars are set and there's no OIDC fallback,
  // surface a clear error so the misconfiguration is obvious.
  if (token || teamId || projectId) {
    throw new Error(
      "Missing Vercel Sandbox credentials: set VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID together, or provide VERCEL_OIDC_TOKEN.",
    );
  }

  return undefined;
}
