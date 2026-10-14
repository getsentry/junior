/**
 * Blocked report of a child agent.
 *
 * A child agent's reply goes to its parent agent, not to a person. When
 * missing access, input, or a decision stops its task, the child ends its run
 * with `reportBlocked`. Then the agent invocation ends as `blocked` with what
 * is missing, and the parent does not read the reply as finished work.
 */
import { z } from "zod";
import {
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
} from "@/chat/pi/transcript";

/** Model-facing tool that ends a child agent run as blocked. */
export const REPORT_BLOCKED_TOOL_NAME = "reportBlocked";

/** What a child agent needs before it can finish its task. */
export const blockedReportSchema = z.object({
  missing: z.string().trim().min(1),
});

/** What a child agent needs before it can finish its task. */
export type BlockedReport = z.output<typeof blockedReportSchema>;

/**
 * Read the last successful blocked report from the new messages of one run.
 *
 * Do not pass the whole history. A named child keeps its history, so a report
 * from an earlier agent invocation must not end the current one.
 */
export function readBlockedReport(
  messages: readonly unknown[],
): BlockedReport | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !isToolResultMessage(message) ||
      isToolResultError(message) ||
      normalizeToolNameFromResult(message) !== REPORT_BLOCKED_TOOL_NAME
    ) {
      continue;
    }
    const parsed = blockedReportSchema.safeParse(message.details);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}
