import type {
  AfterToolCallResult,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";

/**
 * Project a host-preempted tool attempt onto the normal tool-result shape.
 *
 * Only rewrite results that mark the attempt itself as aborted. A finished
 * sibling tool that settles after the host abort signal must keep its real
 * outcome. Host continuity stays in session state (`resumeReason: "timeout"`)
 * and automatic continuation. The model only needs the same fact bash already
 * reports for command timeouts: this attempt timed out.
 */
export function projectTimedOutToolResult(
  result: AgentToolResult<unknown>,
): AfterToolCallResult | undefined {
  const details = result.details;
  if (
    !details ||
    typeof details !== "object" ||
    Array.isArray(details) ||
    !("aborted" in details) ||
    details.aborted !== true
  ) {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  const target =
    typeof record.target === "string" && record.target.length > 0
      ? record.target
      : undefined;
  const envelope = makeStructuredToolOutput({
    ...(target ? { target } : undefined),
    timed_out: true as const,
  });
  return {
    content: envelope.content,
    details: envelope.details,
    isError: false,
  };
}
