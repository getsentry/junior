import type {
  AfterToolCallResult,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";

/**
 * Replace an aborted tool result with a model-safe unconfirmed outcome.
 *
 * Timeout recovery is owned by session state (`resumeReason: "timeout"`). The
 * tool result only needs to say the prior attempt is unconfirmed — not that a
 * host slice deadline cancelled the command.
 */
export function projectUnconfirmedToolResult(
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
    outcome: "unconfirmed" as const,
  });
  return {
    content: envelope.content,
    details: envelope.details,
    isError: false,
  };
}
