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

export function getVercelSandboxCredentials():
  | VercelSandboxCredentials
  | undefined {
  const token = toOptionalTrimmed(process.env.VERCEL_TOKEN);
  const teamId = toOptionalTrimmed(process.env.VERCEL_TEAM_ID);
  const projectId = toOptionalTrimmed(process.env.VERCEL_PROJECT_ID);

  if (!token && !teamId && !projectId) {
    return undefined;
  }

  if (!token || !teamId || !projectId) {
    throw new Error(
      "Missing Vercel Sandbox credentials: set VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID together.",
    );
  }

  return {
    token,
    teamId,
    projectId,
  };
}
