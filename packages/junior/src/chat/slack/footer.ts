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
 * Build Slack blocks for a reply chunk.
 *
 * `bodyFormat` selects how the main body block is rendered:
 * - `"commonmark"` (default) uses the Slack-flavored `markdown` block, which
 *   Slack renders natively from standard Markdown. Use this for model-authored
 *   text normalized by `normalizeSlackReplyMarkdown`.
 * - `"mrkdwn"` uses a `section` block with a `mrkdwn` text object. Use this
 *   only for text that is already Slack mrkdwn (Slack mention syntax like
 *   `<@U123>`, single-`*` emphasis, `<url>` links) such as auth-pause
 *   notices built by `buildAuthPauseResponse`. Slack's markdown-to-rich_text
 *   converter mishandles raw mrkdwn tokens inside a `markdown` block and
 *   rejects the message with `invalid_blocks`.
 */
export function buildSlackReplyBlocks(
  text: string,
  footer: SlackReplyFooter | undefined,
  bodyFormat: "commonmark" | "mrkdwn" = "commonmark",
): SlackMessageBlock[] | undefined {
  if (!text.trim()) {
    return undefined;
  }

  const blocks: SlackMessageBlock[] = [
    bodyFormat === "mrkdwn"
      ? { type: "section", text: { type: "mrkdwn", text } }
      : { type: "markdown", text },
  ];

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
