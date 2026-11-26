// Kept apart from the Drizzle table so browser code that imports these
// values does not bundle drizzle-orm and the table definitions.

export const CHILD_AGENT_STATUSES = [
  "pending",
  "running",
  "paused",
  "blocked",
  "completed",
  "failed",
  "stopped",
] as const;
