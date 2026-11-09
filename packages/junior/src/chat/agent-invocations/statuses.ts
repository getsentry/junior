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
 * Parent mailbox append state. Only terminal invocations have a value.
 * `replaced` means the child still had open work, so a later agent invocation
 * on the same child sends the result instead. `skipped` means a stop ended
 * the work, so the result is never used. `steered` means the agent invocation
 * that was running read the input as a steering message, so its result covers
 * this one.
 */
export const AGENT_INVOCATION_PARENT_MAILBOX_STATUSES = [
  "pending",
  "appended",
  "replaced",
  "skipped",
  "steered",
] as const;

export type AgentInvocationParentMailboxStatus =
  (typeof AGENT_INVOCATION_PARENT_MAILBOX_STATUSES)[number];

/**
 * Parent mailbox statuses of a result that goes, or went, to the parent. Only
 * these results count as a result of the child agent.
 */
export const SENT_PARENT_MAILBOX_STATUSES = [
  "pending",
  "appended",
] as const satisfies readonly AgentInvocationParentMailboxStatus[];
