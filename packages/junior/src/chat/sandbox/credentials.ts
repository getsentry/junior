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

function isVercelRuntime(): boolean {
  return (
    process.env.VERCEL === "1" ||
    Boolean(process.env.VERCEL_ENV) ||
    Boolean(process.env.VERCEL_REGION) ||
    Boolean(process.env.VERCEL_URL)
  );
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

  // Let the SDK resolve credentials whenever Vercel OIDC is available.
  // In local/dev this may come from VERCEL_OIDC_TOKEN, while on Vercel
  // the SDK can also resolve runtime request context directly.
  if (toOptionalTrimmed(process.env.VERCEL_OIDC_TOKEN) || isVercelRuntime()) {
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
