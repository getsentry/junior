import type {
  AfterToolCallResult,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";

/**
 * Project a host-preempted tool attempt onto the normal tool-result shape.
 *
 * Host continuity stays in session state (`resumeReason: "timeout"`) and
 * automatic continuation. The model only needs the same fact bash already
 * reports for command timeouts: this attempt timed out.
 */
export function projectTimedOutToolResult(
  result: AgentToolResult<unknown>,
): AfterToolCallResult {
  const details = result.details;
  const record =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : undefined;
  const target =
    typeof record?.target === "string" && record.target.length > 0
      ? record.target
      : undefined;
  const envelope = makeStructuredToolOutput({
    ...(target ? { target } : {}),
    timed_out: true as const,
  });
  return {
    content: envelope.content,
    details: envelope.details,
    isError: false,
  };
}
