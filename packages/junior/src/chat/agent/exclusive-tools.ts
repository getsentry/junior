import { REPORT_BLOCKED_TOOL_NAME } from "@/chat/agent-invocations/blocked-report";
import { REPLY_TOOL_NAME } from "@/chat/turn-answer";
import { NO_REPLY_TOOL_NAME } from "@/chat/no-reply";

/**
 * Tools that must be the only tool call in their assistant message. Each one
 * must be `modelOnly`: this check does not see script or `executeTool` calls.
 */
const EXCLUSIVE_TOOL_NAMES = [
  "switchWorkspace",
  REPLY_TOOL_NAME,
  REPORT_BLOCKED_TOOL_NAME,
  NO_REPLY_TOOL_NAME,
] as const;

/** Return the exclusive tool name when one is present among the calls. */
export function exclusiveToolName(
  toolCalls: ReadonlyArray<{ name: string }>,
): string | undefined {
  for (const name of EXCLUSIVE_TOOL_NAMES) {
    if (toolCalls.some((call) => call.name === name)) {
      return name;
    }
  }
  return undefined;
}
