/**
 * Destination-visible Slack reply delivery.
 *
 * Owns chunking, conversation footer attachment, and outbound posting.
 */
import type { MessageCard } from "@/chat/conversations/cards";
import { renderSlackCard, type SlackCard } from "./cards";
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
  cards?: MessageCard[];
  channelId: string;
  conversationId: string;
  replyAttribution?: ReplyAttribution;
  text: string;
  threadTs?: string;
}): Promise<string[]> {
  const posts: Array<{ text: string; cards: SlackCard[] }> =
    splitSlackReplyText(args.text).map((text) => ({ text, cards: [] }));
  const cards = (args.cards ?? []).map(renderSlackCard);
  // Keep previews in small groups so one reply does not become a wall of cards.
  for (let index = 0; index < cards.length; index += 5) {
    const group = cards.slice(index, index + 5);
    const lastPost = posts.at(-1);
    if (index === 0 && lastPost) lastPost.cards = group;
    else posts.push({ text: "", cards: group });
  }
  const footer = buildSlackReplyFooter({
    conversationId: args.conversationId,
    replyAttribution: args.replyAttribution,
  });
  const messageTs: string[] = [];
  // Keep the thread root. Slack wants the parent message ts, not each reply's ts.
  // With no inbound thread, the first posted chunk becomes that root.
  let threadTs = args.threadTs;

  for (const [index, post] of posts.entries()) {
    const { text, cards } = post;
    const isFinalChunk = index === posts.length - 1;
    const blocks = buildSlackReplyBlocks(text, undefined) ?? [];
    for (const card of cards) {
      if (!card.entity) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: card.text },
        });
      }
    }
    // Card-only posts keep a visible footer rather than repeat notification text.
    if (isFinalChunk || !text.trim()) {
      blocks.push(...(buildSlackReplyBlocks("", footer) ?? []));
    }
    const entities = cards.flatMap((card) =>
      card.entity ? [card.entity] : [],
    );
    const accessibleText = [text, ...cards.map((card) => card.text)]
      .filter(Boolean)
      .join("\n\n");
    const fallbackText =
      isFinalChunk && args.replyAttribution
        ? `${accessibleText}\n\n${escapeSlackMrkdwnText(formatReplyAttribution(args.replyAttribution))}`
        : accessibleText;
    const response = await postSlackMessage({
      channelId: args.channelId,
      threadTs,
      text: fallbackText,
      ...(blocks.length ? { blocks } : undefined),
      ...(entities.length ? { entities } : undefined),
    });
    if (response.ts) {
      messageTs.push(response.ts);
      threadTs ??= response.ts;
    }
  }

  return messageTs;
}
