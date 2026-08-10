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
  label?: string;
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
  hasDashboardActivity?: boolean;
  replyAttribution?: ReplyAttribution;
}): SlackReplyFooter | undefined {
  const items: SlackReplyFooterItem[] = [];

  const conversationId = args.conversationId?.trim();
  if (conversationId) {
    const idItem: SlackReplyFooterItem = {
      label: "ID",
      value: conversationId,
    };
    const dashboardUrl = getDashboardConversationLink(conversationId);
    if (dashboardUrl) {
      if (args.hasDashboardActivity) {
        items.push({
          url: dashboardUrl,
          value: "See dashboard activity in Junior",
        });
      }
      items.push({
        label: "Open in Junior",
        url: dashboardUrl,
        value: conversationId,
      });
    } else {
      idItem.url =
        getPluginSlackConversationLink(conversationId)?.url ??
        buildSentryConversationUrl(conversationId);
      items.push(idItem);
    }
  }

  return items.length > 0 || args.replyAttribution
    ? {
        ...(args.replyAttribution
          ? { attribution: args.replyAttribution }
          : {}),
        items,
      }
    : undefined;
}

/** Build Slack blocks for a reply chunk using the Slack-flavored markdown block for the body. */
export function buildSlackReplyBlocks(
  text: string,
  footer: SlackReplyFooter | undefined,
): SlackMessageBlock[] | undefined {
  if (!text.trim()) {
    return undefined;
  }

  const blocks: SlackMessageBlock[] = [
    {
      type: "markdown",
      text,
    },
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
            ? item.label
              ? `*${escapeSlackMrkdwnText(item.label)}:* ${formatSlackLink(item.url, item.value)}`
              : formatSlackLink(item.url, item.value)
            : item.label
              ? `*${escapeSlackMrkdwnText(item.label)}:* ${escapeSlackMrkdwnText(item.value)}`
              : escapeSlackMrkdwnText(item.value),
        })),
      ],
    });
  }

  return blocks;
}
