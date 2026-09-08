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

/**
 * Controls which Slack block type is used for the reply body.
 *
 * - `"commonmark"` (default): wraps the text in a `{ type: "markdown" }` block,
 *   which Slack renders from standard Markdown (bold, links, tables, headers).
 *   Use this for normal agent replies where `normalizeSlackReplyMarkdown` has
 *   already formatted the output for CommonMark delivery.
 *
 * - `"mrkdwn"`: wraps the text in a `{ type: "section", text: { type: "mrkdwn" } }`
 *   block. Use this when the text is already pre-formatted as Slack mrkdwn
 *   (e.g. `<@user>` mentions, `<url>` angle-bracket links, single-`*` emphasis)
 *   and must not be passed through the markdown-to-rich_text converter, which
 *   can mis-tag mrkdwn tokens and trigger `invalid_blocks`.
 */
export type SlackReplyBodyFormat = "commonmark" | "mrkdwn";

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
 * The body block format is controlled by `bodyFormat`:
 * - `"commonmark"` (default): uses `{ type: "markdown" }` for CommonMark rendering.
 * - `"mrkdwn"`: uses `{ type: "section", text: { type: "mrkdwn" } }` for
 *   pre-formatted mrkdwn text (e.g. auth-pause notices with `<@user>` mentions).
 */
export function buildSlackReplyBlocks(
  text: string,
  footer: SlackReplyFooter | undefined,
  bodyFormat: SlackReplyBodyFormat = "commonmark",
): SlackMessageBlock[] | undefined {
  if (!text.trim()) {
    return undefined;
  }

  const bodyBlock: SlackMessageBlock =
    bodyFormat === "mrkdwn"
      ? { type: "section", text: { type: "mrkdwn", text } }
      : { type: "markdown", text };

  const blocks: SlackMessageBlock[] = [bodyBlock];

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
