import type {
  AfterToolCallResult,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import {
  juniorToolResultSchema,
  makeStructuredToolResult,
} from "@/chat/tool-support/structured-result";

const TURN_DEADLINE_INTERRUPTION = {
  cause: "turn_deadline",
  scope: "execution_slice",
  task_status: "active",
} as const;

/** Mark an unknown tool outcome as caused by an internal execution-slice deadline. */
export function annotateTurnDeadlineToolResult(
  result: AgentToolResult<unknown>,
): AfterToolCallResult | undefined {
  const parsed = juniorToolResultSchema.safeParse(result.details);
  if (!parsed.success) {
    return undefined;
  }
  const error = parsed.data.error;
  if (!error || typeof error !== "object" || error.kind !== "outcome_unknown") {
    return undefined;
  }

  const details = {
    ...parsed.data,
    interruption: TURN_DEADLINE_INTERRUPTION,
    error: {
      ...error,
      message:
        "Tool execution was interrupted when the current execution slice reached its internal deadline. The original task remains active, but this tool call's outcome is unknown and may include side effects.",
    },
  };
  const envelope = makeStructuredToolResult(details, {
    content: result.content.slice(1),
  });
  return {
    content: envelope.content,
    details: envelope.details,
    isError: true,
  };
}
