/** Blocked report of a child agent. See "Blocked Reports" in README.md. */
import { z } from "zod";
import {
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
} from "@/chat/pi/transcript";

/** Model-facing tool that ends a child agent run as blocked. */
export const REPORT_BLOCKED_TOOL_NAME = "reportBlocked";

const blockedReportSchema = z.object({
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
