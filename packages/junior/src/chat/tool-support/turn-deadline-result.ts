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

  const details = {
    ...result.details,
    interruption: TURN_DEADLINE_INTERRUPTION,
  };
  const envelope = makeStructuredToolOutput(details, {
    content: result.content.slice(1),
  });
  return {
    content: envelope.content,
    details: envelope.details,
    isError: true,
  };
}
