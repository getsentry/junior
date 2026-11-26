// Kept apart from the Drizzle table so browser code that imports these
// values does not bundle drizzle-orm and the table definitions.
import type { AgentUpdateStatus } from "./agent-update";

/**
 * How a finished Turn of a child agent ended: the status of its agent
 * update. A stop is not a result.
 */
export const CHILD_AGENT_RESULTS = [
  "done",
  "blocked",
  "failed",
] as const satisfies readonly AgentUpdateStatus[];
