import type {
  AfterToolCallResult,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";

/**
 * Replace a host-aborted tool result with a model-facing timed-out outcome.
 *
 * Host continuity is owned by session state (`resumeReason: "timeout"`) and
 * automatic continuation. The tool result only records that this attempt did
 * not finish — not cancelled/deadline jargon.
 */
export function projectTimedOutToolResult(
  result: AgentToolResult<unknown>,
): AfterToolCallResult | undefined {
  const details = result.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }

  const record = details as Record<string, unknown>;
  if (record.aborted !== true) {
    return undefined;
  }

  const target =
    typeof record.target === "string" && record.target.length > 0
      ? record.target
      : undefined;
  const envelope = makeStructuredToolOutput({
    ...(target ? { target } : {}),
    outcome: "timed_out" as const,
  });
  return {
    content: envelope.content,
    details: envelope.details,
    isError: false,
  };
}
