import type { SlackLocation } from "@sentry/junior-plugin-api";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
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
 * Run it inside the Slack installation of `location.teamId`.
 */
export async function postSlackDetachNotice(args: {
  actorName: string;
  conversationId: string;
  location: SlackLocation;
}): Promise<void> {
  const { location } = args;
  if (!location.threadTs) return;
  // ast-grep-ignore: no-raw-slack-turn-post -- detach notice, not Turn output
  await postSlackMessage({
    channelId: location.channelId,
    text: detachNoticeText(args.conversationId, args.actorName),
    threadTs: location.threadTs,
  });
}

/**
 * Tell a Slack thread that its Conversation moved into a Space. The move
 * drops the thread as its Location, so replies continue only on the web.
 * Call it only when the move changed state. Run it inside the Slack
 * installation of `location.teamId`.
 */
export async function postSlackMovedNotice(args: {
  conversationId: string;
  location: SlackLocation;
}): Promise<void> {
  const { location } = args;
  const url = getDashboardConversationLink(args.conversationId);
  if (!location.threadTs || !url) return;
  // ast-grep-ignore: no-raw-slack-turn-post -- moved notice, not Turn output
  await postSlackMessage({
    channelId: location.channelId,
    text: `This conversation moved to the web: ${formatSlackLink(url, url)}`,
    threadTs: location.threadTs,
  });
}
