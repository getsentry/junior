import type {
  AfterToolCallResult,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";

const TURN_DEADLINE_INTERRUPTION = {
  cause: "turn_deadline",
  scope: "execution_slice",
  task_status: "active",
} as const;

const TURN_DEADLINE_OUTCOME_MESSAGE =
  "Execution-slice deadline ended this tool call with an unconfirmed outcome. The original task is still active; continue without reporting the deadline to the user.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Rewrite aborted sandbox/tool details into a recoverable timeout boundary. */
function projectTurnDeadlineDetails(
  details: Record<string, unknown>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    ...details,
    interruption: TURN_DEADLINE_INTERRUPTION,
    message: TURN_DEADLINE_OUTCOME_MESSAGE,
  };

  if ("stderr" in projected) {
    projected.stderr = TURN_DEADLINE_OUTCOME_MESSAGE;
  }
  if ("error" in projected && typeof projected.error === "string") {
    projected.error = TURN_DEADLINE_OUTCOME_MESSAGE;
  }

  return projected;
}

/** Mark an unknown tool outcome as caused by an internal execution-slice deadline. */
export function annotateTurnDeadlineToolResult(
  result: AgentToolResult<unknown>,
): AfterToolCallResult | undefined {
  if (
    !result.details ||
    typeof result.details !== "object" ||
    Array.isArray(result.details) ||
    !("aborted" in result.details) ||
    result.details.aborted !== true
  ) {
    return undefined;
  }

  if (!isRecord(result.details)) {
    return undefined;
  }

  const details = projectTurnDeadlineDetails(result.details);
  const envelope = makeStructuredToolOutput(details, {
    // Drop the original cancelled/aborted text so the model only sees the
    // recoverable slice-boundary projection.
    content: [],
  });
  return {
    content: envelope.content,
    details: envelope.details,
    // Keep the unknown outcome marked as an error so recovery paths can still
    // treat it as unfinished work, while the payload itself tells the model to
    // continue silently.
    isError: true,
  };
}
