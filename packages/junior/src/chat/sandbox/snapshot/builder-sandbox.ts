import { Sandbox } from "@vercel/sandbox";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import { isSandboxMissingError } from "@/chat/sandbox/errors";

/** Resume the named Sandbox that owns one Workspace snapshot build. */
export async function getWorkspaceSnapshotBuilder(
  name: string,
  signal?: AbortSignal,
): Promise<Sandbox> {
  const credentials = getVercelSandboxCredentials();
  return await Sandbox.get({
    name,
    resume: true,
    signal,
    ...(credentials ?? {}),
  });
}

/** Permanently delete named Workspace snapshot builders without resuming them. */
export async function deleteWorkspaceSnapshotBuilders(
  names: Iterable<string>,
): Promise<void> {
  const credentials = getVercelSandboxCredentials();
  let hasError = false;
  let firstError: unknown;
  for (const name of new Set(names)) {
    try {
      const sandbox = await Sandbox.get({
        name,
        resume: false,
        ...(credentials ?? {}),
      });
      await sandbox.delete();
    } catch (error) {
      if (!isSandboxMissingError(error)) {
        if (!hasError) firstError = error;
        hasError = true;
      }
    }
  }
  if (hasError) throw firstError;
}
