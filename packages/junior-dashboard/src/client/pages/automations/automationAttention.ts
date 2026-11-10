import type { AutomationSummary } from "@sentry/junior/api/schema";

/**
 * Say why an Automation needs attention, in the words the Inbox and the
 * Automations list share. It mirrors the `attention` scope of the
 * Automation collection: blocked, an unavailable trigger, or a last run
 * that failed or blocked.
 */
export function automationAttentionReason(
  automation: AutomationSummary,
): string {
  if (automation.status === "blocked") return "Blocked";
  if (automation.kind === "event" && automation.trigger.problems.length > 0)
    return "Trigger unavailable";
  if (automation.lastRunStatus === "blocked") return "Last run blocked";
  return "Last run failed";
}
