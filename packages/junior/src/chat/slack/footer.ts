import type { ReplyAttribution } from "@sentry/junior-plugin-api";
import { buildSentryConversationUrl } from "@/chat/sentry-links";
import { getPluginSlackConversationLink } from "@/chat/plugins/agent-hooks";
import { getDashboardConversationLink } from "@/chat/slack/dashboard-link";
import { escapeSlackMrkdwnText, formatSlackLink } from "@/chat/slack/mrkdwn";

interface SlackMrkdwnTextObject {
  text: string;
  type: "mrkdwn";
}

interface SlackPlainTextObject {
  text: string;
  type: "plain_text";
}

/** Slack-flavored Markdown block — accepts a standard Markdown subset and Slack renders it natively. */
interface SlackMarkdownBlock {
  text: string;
  type: "markdown";
}

interface SlackSectionBlock {
  text: SlackMrkdwnTextObject;
  type: "section";
}

interface SlackContextBlock {
  elements: Array<SlackMrkdwnTextObject | SlackPlainTextObject>;
  type: "context";
}

export type SlackMessageBlock =
  | SlackMarkdownBlock
  | SlackSectionBlock
  | SlackContextBlock;

interface SlackReplyFooterItem {
  label: string;
  url?: string;
  value: string;
}

export interface SlackReplyFooter {
  attribution?: ReplyAttribution;
  items: SlackReplyFooterItem[];
}

/** Render compact reply attribution for the Slack footer. */
export function formatReplyAttribution(attribution: ReplyAttribution): string {
  return attribution.detail
    ? `${attribution.label} · ${attribution.detail}`
    : attribution.label;
}

/**
 * Build the compact conversation footer for visible Slack reply surfaces.
 *
 * Detailed turn metrics stay in the dashboard instead of Slack-visible copy.
 */
export function buildSlackReplyFooter(args: {
  conversationId?: string;
  replyAttribution?: ReplyAttribution;
}): SlackReplyFooter | undefined {
  const items: SlackReplyFooterItem[] = [];

  const conversationId = args.conversationId?.trim();
  if (conversationId) {
    const idItem: SlackReplyFooterItem = {
      label: "ID",
      value: conversationId,
    };
    const conversationUrl =
      getPluginSlackConversationLink(conversationId)?.url ??
      getDashboardConversationLink(conversationId) ??
      buildSentryConversationUrl(conversationId);
    if (conversationUrl) {
      idItem.url = conversationUrl;
    }
    items.push(idItem);
  }

  return items.length > 0 || args.replyAttribution
    ? {
        ...(args.replyAttribution
          ? { attribution: args.replyAttribution }
          : undefined),
        items,
      }
    : undefined;
}

/**
 * Slack's `markdown` block renders standard Markdown and has no user-mention
 * syntax (see docs.slack.dev/reference/block-kit/blocks/markdown-block). A
 * literal `<@id>` mention token — valid only in `mrkdwn` text — left inside a
 * `markdown` block makes Slack's markdown-to-rich_text conversion mis-tag an
 * inline element and reject the whole message with `invalid_blocks`
 * (JUNIOR-72). Replies that open with a mention (for example auth-pause
 * notices) split that mention into its own `mrkdwn` context block instead.
 */
const LEADING_SLACK_MENTION_RE = /^<@([UW][A-Z0-9]+)>[ \t]*/;

/** Build Slack blocks for a reply chunk using the Slack-flavored markdown block for the body. */
export function buildSlackReplyBlocks(
  text: string,
  footer: SlackReplyFooter | undefined,
): SlackMessageBlock[] | undefined {
  if (!text.trim()) {
    return undefined;
  }

  const mentionMatch = LEADING_SLACK_MENTION_RE.exec(text);
  const body = mentionMatch ? text.slice(mentionMatch[0].length) : text;

  const blocks: SlackMessageBlock[] = [];
  if (mentionMatch) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: mentionMatch[0].trimEnd() }],
    });
  }
  blocks.push({
    type: "markdown",
    text: body,
  });

  if (mentionMatch && !body.trim()) {
    // A mention-only reply has nothing left for the markdown block. Drop it
    // rather than post a Slack-rejected empty `markdown` block.
    blocks.pop();
  }

  if (footer && (footer.attribution || footer.items.length > 0)) {
    const attributionElements: SlackPlainTextObject[] = footer.attribution
      ? [
          {
            type: "plain_text",
            text: formatReplyAttribution(footer.attribution),
          },
        ]
      : [];
    blocks.push({
      type: "context",
      elements: [
        ...attributionElements,
        ...footer.items.map((item) => ({
          type: "mrkdwn" as const,
          text: item.url
            ? `*${escapeSlackMrkdwnText(item.label)}:* ${formatSlackLink(item.url, item.value)}`
            : `*${escapeSlackMrkdwnText(item.label)}:* ${escapeSlackMrkdwnText(item.value)}`,
        })),
      ],
    });
  }

  return blocks;
}
