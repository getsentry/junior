import { addConversationNote } from "@/chat/conversations/notes";
import type { ConversationStore } from "@/chat/conversations/store";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { formatSlackLink } from "@/chat/slack/mrkdwn";
// ast-grep-ignore: no-raw-slack-turn-post -- moved notice, not Turn output
import { postSlackMessage } from "@/chat/slack/outbound";

/**
 * Tell a Slack thread once that its Conversation moved to the web. A
 * Conversation that started in the thread and then moved into a Space, or
 * left one, no longer has the thread as its Destination, so the thread gets
 * no replies. The note that this adds is the record that the notice went
 * out, so later messages in the thread get none. Run it inside the Slack
 * installation of the thread.
 */
export async function postSlackMovedNotice(args: {
  channelId: string;
  conversationId: string;
  conversationStore: ConversationStore;
  /** The id of a Conversation that started in this thread. */
  threadConversationId: string;
  threadTs: string;
}): Promise<void> {
  if (args.conversationId !== args.threadConversationId) return;
  const conversation = await args.conversationStore.get({
    conversationId: args.conversationId,
  });
  // A moved Conversation always has a Destination. A missing one means it
  // never moved, so it gets no notice.
  const destination = conversation?.destination;
  if (!destination || destination.platform === "slack") return;
  const url = getDashboardConversationLink(args.conversationId);
  if (!url) return;
  const added = await addConversationNote({
    conversationId: args.conversationId,
    createdAtMs: Date.now(),
    key: "slack-moved-notice",
    text: "The runtime told the Slack thread of this conversation that it moved to the web.",
  });
  if (!added) return;
  // ast-grep-ignore: no-raw-slack-turn-post -- moved notice, not Turn output
  await postSlackMessage({
    channelId: args.channelId,
    text: `This conversation moved to the web: ${formatSlackLink(url, url)}`,
    threadTs: args.threadTs,
  });
}
