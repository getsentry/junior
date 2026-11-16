import type { SlackLocation } from "@sentry/junior-plugin-api";
import { getProductionSlackAdapter } from "@/chat/app/production";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { runBestEffort } from "@/chat/logging";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";
import { escapeSlackMrkdwnText, formatSlackLink } from "@/chat/slack/mrkdwn";
// ast-grep-ignore: no-raw-slack-turn-post -- detach notice, not Turn output
import { postSlackMessage } from "@/chat/slack/outbound";

function detachNoticeText(conversationId: string, actorName: string): string {
  const url = getDashboardConversationLink(conversationId);
  const dashboard = url
    ? formatSlackLink(url, "the dashboard")
    : "the dashboard";
  return `${escapeSlackMrkdwnText(actorName)} detached this conversation from Slack. Updates continue in ${dashboard}. Mention me here to attach it again.`;
}

/**
 * Tell a Slack thread once that its Conversation was detached, so people
 * there know replies stopped. Call it only when the detach changed state.
 * Best-effort: the detach already applied and shows on the dashboard.
 */
export async function postSlackDetachNotice(args: {
  actorName: string;
  conversationId: string;
  location: SlackLocation;
}): Promise<void> {
  const { location } = args;
  if (!location.threadTs) return;
  const threadTs = location.threadTs;
  await runBestEffort(
    () =>
      runWithSlackInstallation({
        adapter: getProductionSlackAdapter(),
        installation: { teamId: location.teamId },
        task: async () => {
          // ast-grep-ignore: no-raw-slack-turn-post -- detach notice, not Turn output
          await postSlackMessage({
            channelId: location.channelId,
            text: detachNoticeText(args.conversationId, args.actorName),
            threadTs,
          });
        },
      }),
    "conversation.detach_notice.failed",
    { "app.conversation.id": args.conversationId },
  );
}
