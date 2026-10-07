import { getDashboardTaskLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { getEventAutomation } from "@/chat/event-automations/store";
import { runBestEffort } from "@/chat/logging";
import { readScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import { fallbackShortTitle } from "@/chat/services/short-title";
import { getSlackClient, withSlackRetries } from "@/chat/slack/client";
import { escapeSlackMrkdwnText, formatSlackLink } from "@/chat/slack/mrkdwn";
import { postSlackMessage } from "@/chat/slack/outbound";

interface BlockedAutomation {
  creatorSlackUserId: string;
  id: string;
  title: string;
}

/** Identify the Automation that a run blocked. */
export interface BlockedAutomationRef {
  automationId: string;
  kind: "event" | "scheduled";
}

async function readBlockedAutomation(
  ref: BlockedAutomationRef,
): Promise<BlockedAutomation | undefined> {
  if (ref.kind === "scheduled") {
    const task = await readScheduledAutomation(getDb(), ref.automationId);
    return task
      ? {
          creatorSlackUserId: task.createdBy.slackUserId,
          id: task.id,
          title:
            task.title ??
            fallbackShortTitle(task.task.text, "Scheduled automation"),
        }
      : undefined;
  }
  const task = await getEventAutomation(getDb(), ref.automationId);
  return task
    ? {
        creatorSlackUserId: task.createdBy.slackUserId,
        id: task.id,
        title:
          task.title ?? fallbackShortTitle(task.task.text, "Event automation"),
      }
    : undefined;
}

function buildBlockedNoticeText(
  automation: BlockedAutomation,
  reason: string,
): string {
  const url = getDashboardTaskLink(automation.id);
  return [
    `Your automation *${escapeSlackMrkdwnText(automation.title)}* is blocked. It won't run again until you resume it.`,
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
      const automation = await readBlockedAutomation(ref);
      if (!automation) return;
      const opened = await withSlackRetries(
        () =>
          getSlackClient().conversations.open({
            users: automation.creatorSlackUserId,
          }),
        3,
        { action: "conversations.open" },
      );
      const channelId = opened.channel?.id;
      if (!channelId) {
        throw new Error("Slack did not return a direct message channel.");
      }
      await postSlackMessage({
        channelId,
        text: buildBlockedNoticeText(automation, ref.reason),
      });
    },
    "automation.blocked_notice.failed",
    {
      "app.task.type": ref.kind,
      "app.dispatch.id": ref.dispatchId,
    },
  );
}
