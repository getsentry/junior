/**
 * Reuse of GitHub App installation tokens. One webhook burst for a pull
 * request reads it several times, and each read used to mint its own token.
 */
import { untilAborted } from "@sentry/junior-plugin-api";
import type { GitHubAppPermissions } from "./permissions.js";

/** A raw installation token and when Junior stops using it. */
export interface InstallationToken {
  expiresAtMs: number;
  token: string;
}

/**
 * Installation tokens by scope. The map stays in process memory, so a token
 * never reaches a store, and it ends with the process.
 */
export type InstallationTokens = Map<string, Promise<InstallationToken>>;

/** A token this close to its expiry is minted again. */
const REUSE_BUFFER_MS = 5 * 60 * 1000;

/**
 * Return the token of the same permissions and repositories while it has
 * time left, or mint one. Concurrent callers share one mint. A failed mint
 * is not kept. `signal` ends only this caller's wait.
 */
export async function reuseInstallationToken(
  tokens: InstallationTokens,
  scope: {
    permissions?: GitHubAppPermissions | undefined;
    repositories?: string[] | undefined;
    repositoryIds?: number[] | undefined;
    signal?: AbortSignal | undefined;
  },
  mint: () => Promise<InstallationToken>,
): Promise<InstallationToken> {
  const key = JSON.stringify([
    scope.permissions ?? null,
    scope.repositories ?? null,
    scope.repositoryIds ?? null,
  ]);
  // Read the map before any await, so a concurrent caller sees this mint.
  const pending = tokens.get(key);
  const reused =
    pending &&
    (await untilAborted(
      pending.catch(() => undefined),
      scope.signal,
    ));
  if (reused && reused.expiresAtMs - REUSE_BUFFER_MS > Date.now()) {
    return reused;
  }
  const minted = mint();
  tokens.set(key, minted);
  // Only a failed mint is dropped, not one that this caller stopped waiting
  // for. This runs before the caller sees the failure.
  minted.catch(() => {
    if (tokens.get(key) === minted) tokens.delete(key);
  });
  return await untilAborted(minted, scope.signal);
}
