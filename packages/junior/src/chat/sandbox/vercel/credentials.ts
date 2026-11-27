import { getChatConfig } from "@/chat/config";

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
  const { token, teamId, projectId } = getChatConfig().sandbox.vercel;

  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }

  // Let the SDK read ambient auth itself unless we're intentionally using the
  // documented explicit token/team/project fallback.
  return undefined;
}
