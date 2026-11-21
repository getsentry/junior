/**
 * Destination-visible Slack reply delivery.
 *
 * Owns chunking, conversation footer attachment, and outbound posting.
 */
import type { MessageCard } from "@/chat/conversations/cards";
import { renderSlackCard, type SlackCard } from "./cards";
import type { ReplyAttribution, Source } from "@sentry/junior-plugin-api";
import type { Location } from "@/chat/conversations/location";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
  formatReplyAttribution,
} from "@/chat/slack/footer";
import { escapeSlackMrkdwnText } from "@/chat/slack/mrkdwn";
import { resolveHandleMentions } from "@/chat/events/people";
import { logWarn } from "@/chat/logging";
import { postSlackMessage } from "@/chat/slack/outbound";
import { splitSlackReplyText } from "@/chat/slack/output";
import { fitsSlackMetadataLimit } from "./work-object";

/** Slack channel and optional thread where a Turn posts. */
export interface SlackReplyTarget {
  channelId: string;
  threadTs?: string | undefined;
}

/**
 * Resolve where a Turn posts in Slack.
 *
 * The channel is always the Destination channel. The thread comes from the
 * Turn Source, then the Conversation Location, then the Destination, and each
 * one counts only when it names that channel. Do not derive the target from
 * the Conversation id: an Automation or Watch Conversation can own a Slack
 * thread, and its id is not a Slack thread id.
 */
export function resolveSlackReplyTarget(args: {
  destination: SlackReplyTarget;
  location?: Location | undefined;
  source?: Source | undefined;
}): SlackReplyTarget {
  const { channelId } = args.destination;
  const sourceThreadTs =
    args.source?.kind === "slack" && args.source.channelId === channelId
      ? args.source.threadTs
      : undefined;
  const locationThreadTs =
    args.location?.provider === "slack" && args.location.channelId === channelId
      ? args.location.threadTs
      : undefined;
  const threadTs =
    sourceThreadTs ?? locationThreadTs ?? args.destination.threadTs;
  return { channelId, ...(threadTs ? { threadTs } : undefined) };
}

/** Resolve known people for plugin formatting. Fails open, like the hooks. */
async function resolveReplyMentions(
  text: string,
  teamId: string,
): Promise<Map<string, string> | undefined> {
  try {
    return await resolveHandleMentions(text, teamId);
  } catch (error) {
    logWarn("slack.reply.mentions.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Send one destination-visible Slack reply.
 *
 * Chunks oversized text, builds compact attribution and conversation footer
 * context, and posts through the shared Slack outbound boundary. Pass
 * `formatting` for agent replies so plugin formatting can use Location
 * defaults, such as a default repository, and mention known people.
 */
export async function sendSlackReply(args: {
  cards?: MessageCard[] | undefined;
  channelId: string;
  formatting?: {
    configuration?: Record<string, unknown> | undefined;
    /** Slack workspace whose people `@handle` words can mention. */
    teamId: string;
  };
  conversationId: string;
  replyAttribution?: ReplyAttribution | undefined;
  text: string;
  threadTs?: string | undefined;
}): Promise<string[]> {
  const format = args.formatting && {
    configuration: args.formatting.configuration,
    mentions: await resolveReplyMentions(args.text, args.formatting.teamId),
  };
  const posts: Array<{ text: string; cards: SlackCard[] }> =
    splitSlackReplyText(args.text, format).map((text) => ({
      text,
      cards: [],
    }));
  // Keep previews in small groups so one reply does not become a wall of
  // cards. Slack ignores all metadata of a post that is too large, so a card
  // that does not fit its group starts the next post, and a card that is too
  // large alone posts as text.
  const groups: SlackCard[][] = [];
  for (const card of args.cards ?? []) {
    const rendered = renderSlackCard(card, args.conversationId);
    const slackCard =
      rendered.entity && !fitsSlackMetadataLimit([rendered.entity])
        ? { entity: null, text: rendered.text }
        : rendered;
    const group = groups.at(-1);
    const entities = [...(group ?? []), slackCard].flatMap((item) =>
      item.entity ? [item.entity] : [],
    );
    if (group && group.length < 5 && fitsSlackMetadataLimit(entities)) {
      group.push(slackCard);
    } else {
      groups.push([slackCard]);
    }
  }
  for (const [index, group] of groups.entries()) {
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
    // oxlint-disable-next-line no-await-in-loop -- Post reply chunks in order; the first one can set the thread root.
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
