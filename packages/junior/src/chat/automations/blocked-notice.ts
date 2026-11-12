import type { KnownBlock } from "@slack/types";
import { automationTaskDescription } from "@/chat/automations/task";
import { isConnectableProvider } from "@/chat/credentials/connections";
import { getDashboardTaskLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { getEventAutomation } from "@/chat/event-automations/store";
import { runBestEffort } from "@/chat/logging";
import { formatProviderLabel } from "@/chat/oauth-flow";
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

/** Action id of the button that connects the account a blocked run needs. */
export const AUTOMATION_CONNECT_ACTION_ID = "automation_connect_account";

function buildBlockedNotice(args: {
  authorizationProvider?: string;
  automationId: string;
  reason: string;
  title: string;
}): { blocks?: KnownBlock[]; text: string } {
  const url = getDashboardTaskLink(args.automationId);
  const resume = url
    ? `then ${formatSlackLink(url, "resume it")}`
    : "then ask me to resume it";
  const providerLabel =
    args.authorizationProvider &&
    isConnectableProvider(args.authorizationProvider)
      ? formatProviderLabel(args.authorizationProvider)
      : undefined;
  const text = [
    `Your automation *${escapeSlackMrkdwnText(args.title)}* is blocked. It won't run again until you resume it.`,
    `> ${escapeSlackMrkdwnText(args.reason.replace(/\s+/g, " ").trim())}`,
    providerLabel
      ? `Connect your ${escapeSlackMrkdwnText(providerLabel)} account, ${resume}.`
      : `Fix the problem, ${resume}.`,
  ].join("\n");
  if (!providerLabel) return { text };
  // OAuth links expire in minutes, and the creator may read this much later.
  // The button starts a new flow for the person who clicks it.
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: AUTOMATION_CONNECT_ACTION_ID,
            style: "primary",
            text: { type: "plain_text", text: `Connect ${providerLabel}` },
            value: args.authorizationProvider,
          },
        ],
      },
    ],
  };
}

/**
 * Tell an Automation's creator in a direct message that a run blocked it,
 * and why. Call this once, after the Automation itself is stored as blocked,
 * so the dashboard matches the notice. The notice is best-effort: the reason
 * also shows on the dashboard and in the Automation tools.
 */
export async function notifyAutomationBlocked(
  ref: BlockedAutomationRef & {
    /** Provider whose account the creator must connect, if that is the fix. */
    authorizationProvider?: string;
    /** The blocked dispatch. A run that blocked before dispatch has none. */
    dispatchId?: string;
    reason: string;
  },
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
          automationTaskDescription(task.task),
          ref.kind === "scheduled"
            ? "Scheduled automation"
            : "Event automation",
        );
      await postSlackMessage({
        channelId: await openSlackDirectMessage(task.createdBy.slackUserId),
        ...buildBlockedNotice({
          authorizationProvider: ref.authorizationProvider,
          automationId: ref.automationId,
          reason: ref.reason,
          title,
        }),
      });
    },
    "automation.blocked_notice.failed",
    {
      "app.task.type": ref.kind,
      ...(ref.dispatchId ? { "app.dispatch.id": ref.dispatchId } : undefined),
    },
  );
}
