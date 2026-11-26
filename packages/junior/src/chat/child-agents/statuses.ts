// Kept apart from the Drizzle table so browser code that imports these
// values does not bundle drizzle-orm and the table definitions.

/** What a child agent does now, as the child agent list shows it. */
export const CHILD_AGENT_STATUSES = [
  "running",
  "blocked",
  "completed",
  "failed",
  "stopped",
] as const;
