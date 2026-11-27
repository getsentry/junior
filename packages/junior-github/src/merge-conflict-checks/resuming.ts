/**
 * The mark of a Resume that is starting a merge conflict fix (`resume.ts`).
 * Core closes the item before the plugin reads the pull request, so until
 * the fix is saved, the mark keeps a conflict check from asking again. A
 * Resume that starts no fix saves nothing, so the next check asks again.
 */
import type { PluginState } from "@sentry/junior-plugin-api";

// Longer than a Resume takes: a GitHub read and a publish. A mark that a
// failed request left lapses after it.
const RESUMING_TTL_MS = 5 * 60_000;

function resumingKey(pullRequestId: string): string {
  return `merge-conflict:resuming:${pullRequestId}`;
}

/** Run `start` with the pull request marked as resuming. */
export async function whileResumingGitHubConflictFixes(
  state: PluginState,
  pullRequestId: string,
  start: () => Promise<void>,
): Promise<void> {
  const key = resumingKey(pullRequestId);
  await state.set(key, true, RESUMING_TTL_MS);
  try {
    await start();
  } finally {
    await state.delete(key);
  }
}

/** Return whether a Resume is starting a fix of the pull request. */
export async function isResumingGitHubConflictFixes(
  state: PluginState,
  pullRequestId: string,
): Promise<boolean> {
  return (await state.get(resumingKey(pullRequestId))) !== undefined;
}
