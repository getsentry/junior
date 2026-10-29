import { toOptionalTrimmed } from "@/chat/optional-string";

interface VercelSandboxCredentials {
  teamId: string;
  projectId: string;
  token: string;
}

/**
 * Resolve explicit Vercel Sandbox credentials, or return undefined to let
 * the SDK read ambient Vercel auth from its own environment detection.
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

  // Let the SDK read ambient auth itself unless we're intentionally using the
  // documented explicit token/team/project fallback.
  return undefined;
}
