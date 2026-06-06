import { AsyncLocalStorage } from "node:async_hooks";

const workspaceTeamIdStorage = new AsyncLocalStorage<string>();

/** Run a callback with the Slack workspace team ID for the inbound webhook. */
export function runWithWorkspaceTeamId<T>(
  teamId: string | undefined,
  fn: () => T,
): T {
  if (!teamId) return fn();
  return workspaceTeamIdStorage.run(teamId, fn);
}

/** Return the Slack workspace team ID for the current inbound webhook. */
export function getWorkspaceTeamId(): string | undefined {
  return workspaceTeamIdStorage.getStore();
}
