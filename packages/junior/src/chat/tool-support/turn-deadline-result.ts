import type {
  AfterToolCallResult,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";

/** Model-visible projection for a tool call whose outcome was not confirmed. */
const UNCONFIRMED_OUTCOME = {
  outcome: "unconfirmed",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readTarget(details: Record<string, unknown>): string | undefined {
  const target = details.target;
  return typeof target === "string" && target.length > 0 ? target : undefined;
}

/**
 * Replace an aborted tool outcome with a model-safe unconfirmed boundary.
 *
 * Timeout recovery is owned by session state (`resumeReason: "timeout"`). The
 * tool result only needs to tell the model the prior attempt is unconfirmed,
 * without runtime deadline jargon or cancelled-command failure text.
 */
export function annotateTurnDeadlineToolResult(
  result: AgentToolResult<unknown>,
): AfterToolCallResult | undefined {
  if (
    !result.details ||
    !isRecord(result.details) ||
    result.details.aborted !== true
  ) {
    return undefined;
  }

  const target = readTarget(result.details);
  const details = {
    ...(target ? { target } : {}),
    ...UNCONFIRMED_OUTCOME,
  };
  const envelope = makeStructuredToolOutput(details);
  return {
    content: envelope.content,
    details: envelope.details,
    isError: false,
  };
}
