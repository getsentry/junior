/**
 * Destination-visible Slack reply delivery.
 *
 * Owns chunking, conversation footer attachment, and outbound posting.
 */
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
} from "@/chat/slack/footer";
import { postSlackMessage } from "@/chat/slack/outbound";
import { splitSlackReplyText } from "@/chat/slack/output";

/**
 * Send one destination-visible Slack reply.
 *
 * Chunks oversized text, builds the conversation footer from
 * `conversationId`, and posts through the shared Slack outbound boundary.
 */
export async function sendSlackReply(args: {
  channelId: string;
  conversationId: string;
  text: string;
  threadTs?: string;
}): Promise<string | undefined> {
  const chunks = splitSlackReplyText(args.text);
  const footer = buildSlackReplyFooter({
    conversationId: args.conversationId,
  });
  let lastMessageTs: string | undefined;

  for (const [index, text] of chunks.entries()) {
    const blocks = buildSlackReplyBlocks(
      text,
      index === chunks.length - 1 ? footer : undefined,
    );
    const response = await postSlackMessage({
      channelId: args.channelId,
      threadTs: args.threadTs,
      text,
      ...(blocks ? { blocks } : {}),
    });
    lastMessageTs = response.ts;
  }

  return lastMessageTs;
}
