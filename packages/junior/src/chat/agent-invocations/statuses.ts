// Kept apart from the Drizzle table so browser code that imports these
// values does not bundle drizzle-orm and the table definitions.

export const AGENT_INVOCATION_STATUSES = [
  "pending",
  "running",
  "paused",
  "blocked",
  "completed",
  "failed",
  "stopped",
] as const;

export const AGENT_INVOCATION_MAILBOX_STATUSES = [
  "pending",
  "appended",
] as const;

/**
 * Old values of `parent_mailbox_status`. This runtime never reads the column.
 * `finishAgentInvocation` writes `appended` when it sent a result and
 * `steered` when the parent is owed none, so a rollback to an older runtime
 * never sends a result again. Remove the column in the cleanup after this
 * release.
 */
export const AGENT_INVOCATION_PARENT_MAILBOX_STATUSES = [
  "pending",
  "appended",
  "replaced",
  "skipped",
  "steered",
] as const;
