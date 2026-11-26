// Kept apart from the Conversation store so browser code that imports these
// values does not bundle the store.

/**
 * What an agent does now, for every agent that a list shows. The words are
 * the Conversation execution status, plus `stopped` after a stop.
 */
export const AGENT_STATUSES = [
  "pending",
  "running",
  "paused",
  "idle",
  "failed",
  "stopped",
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];
