import type { DispatchRecord } from "@/chat/agent-dispatch/types";
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

async function readBlockedAutomation(
  dispatch: DispatchRecord,
): Promise<BlockedAutomation | undefined> {
  const { metadata, source } = dispatch;
  if (source.kind === "scheduled_automation" && metadata?.taskId) {
    const task = await readScheduledAutomation(getDb(), metadata.taskId);
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
  if (source.kind === "event_automation" && metadata?.eventAutomationId) {
    const task = await getEventAutomation(getDb(), metadata.eventAutomationId);
    return task
      ? {
          creatorSlackUserId: task.createdBy.slackUserId,
          id: task.id,
          title:
            task.title ??
            fallbackShortTitle(task.task.text, "Event automation"),
        }
      : undefined;
  }
  return undefined;
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
 * and why. Call this once, when the dispatch first becomes blocked. The
 * notice is best-effort: the Automation is already blocked, and the reason
 * also shows on the dashboard and in the Automation tools.
 */
export async function notifyAutomationBlocked(
  dispatch: DispatchRecord,
): Promise<void> {
  await runBestEffort(
    async () => {
      const automation = await readBlockedAutomation(dispatch);
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
        text: buildBlockedNoticeText(
          automation,
          dispatch.errorMessage ?? "The automation run was blocked.",
        ),
      });
    },
    "automation.blocked_notice.failed",
    {
      "app.dispatch.id": dispatch.id,
      "app.dispatch.source": dispatch.source.kind,
    },
  );
}
