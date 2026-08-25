/**
 * Destination-visible Slack reply delivery.
 *
 * Owns chunking, conversation footer attachment, and outbound posting.
 */
import type { ReplyAttribution } from "@sentry/junior-plugin-api";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
  formatReplyAttribution,
} from "@/chat/slack/footer";
import { escapeSlackMrkdwnText } from "@/chat/slack/mrkdwn";
import { postSlackMessage } from "@/chat/slack/outbound";
import { splitSlackReplyText } from "@/chat/slack/output";

/**
 * Send one destination-visible Slack reply.
 *
 * Chunks oversized text, builds compact attribution and conversation footer
 * context, and posts through the shared Slack outbound boundary.
 */
export async function sendSlackReply(args: {
  channelId: string;
  conversationId: string;
  replyAttribution?: ReplyAttribution;
  text: string;
  threadTs?: string;
}): Promise<string[]> {
  const chunks = splitSlackReplyText(args.text);
  const footer = buildSlackReplyFooter({
    conversationId: args.conversationId,
    replyAttribution: args.replyAttribution,
  });
  const messageTs: string[] = [];
  // Overflow without an inbound thread becomes a thread under the first chunk
  // so channel tops stay one root message (scheduled tasks included).
  let overflowThreadTs = args.threadTs;

  for (const [index, text] of chunks.entries()) {
    const isFinalChunk = index === chunks.length - 1;
    const blocks = buildSlackReplyBlocks(
      text,
      isFinalChunk ? footer : undefined,
    );
    const fallbackText =
      isFinalChunk && args.replyAttribution
        ? `${text}\n\n${escapeSlackMrkdwnText(formatReplyAttribution(args.replyAttribution))}`
        : text;
    const response = await postSlackMessage({
      channelId: args.channelId,
      threadTs: overflowThreadTs,
      text: fallbackText,
      ...(blocks ? { blocks } : undefined),
    });
    if (response.ts) {
      messageTs.push(response.ts);
      if (!overflowThreadTs) {
        overflowThreadTs = response.ts;
      }
    }
  }

  return messageTs;
}
