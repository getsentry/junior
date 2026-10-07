import { getDashboardTaskLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { getEventAutomation } from "@/chat/event-automations/store";
import { runBestEffort } from "@/chat/logging";
import { readScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import { fallbackShortTitle } from "@/chat/services/short-title";
import { escapeSlackMrkdwnText, formatSlackLink } from "@/chat/slack/mrkdwn";
import {
  openSlackDirectMessage,
  postSlackMessage,
} from "@/chat/slack/outbound";

/** Identify the Automation that a run blocked. */
export interface BlockedAutomationRef {
  automationId: string;
  kind: "event" | "scheduled";
}

function buildBlockedNoticeText(
  automationId: string,
  title: string,
  reason: string,
): string {
  const url = getDashboardTaskLink(automationId);
  return [
    `Your automation *${escapeSlackMrkdwnText(title)}* is blocked. It won't run again until you resume it.`,
    `> ${escapeSlackMrkdwnText(reason.replace(/\s+/g, " ").trim())}`,
    url
      ? `Fix the problem, then ${formatSlackLink(url, "resume it")}.`
      : "Fix the problem, then ask me to resume it.",
  ].join("\n");
}

/**
 * Tell an Automation's creator in a direct message that a run blocked it,
 * and why. Call this once, after the Automation itself is stored as blocked,
 * so the dashboard matches the notice. The notice is best-effort: the reason
 * also shows on the dashboard and in the Automation tools.
 */
export async function notifyAutomationBlocked(
  ref: BlockedAutomationRef & { dispatchId: string; reason: string },
): Promise<void> {
  await runBestEffort(
    async () => {
      const task =
        ref.kind === "scheduled"
          ? await readScheduledAutomation(getDb(), ref.automationId)
          : await getEventAutomation(getDb(), ref.automationId);
      if (!task) return;
      const title =
        task.title ??
        fallbackShortTitle(
          task.task.text,
          ref.kind === "scheduled"
            ? "Scheduled automation"
            : "Event automation",
        );
      await postSlackMessage({
        channelId: await openSlackDirectMessage(task.createdBy.slackUserId),
        text: buildBlockedNoticeText(ref.automationId, title, ref.reason),
      });
    },
    "automation.blocked_notice.failed",
    {
      "app.task.type": ref.kind,
      "app.dispatch.id": ref.dispatchId,
    },
  );
}
