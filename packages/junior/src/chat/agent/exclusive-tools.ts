import { REPORT_BLOCKED_TOOL_NAME } from "@/chat/agent-invocations/blocked-report";
import { FINISH_AUTOMATION_RUN_TOOL_NAME } from "@/chat/automation-result";

/** Tools that must be the only tool call in their assistant message. */
const EXCLUSIVE_TOOL_NAMES = [
  "switchWorkspace",
  FINISH_AUTOMATION_RUN_TOOL_NAME,
  REPORT_BLOCKED_TOOL_NAME,
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
