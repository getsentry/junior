import { buildSentryConversationUrl } from "@/chat/sentry-links";
import { getPluginSlackConversationLink } from "@/chat/plugins/agent-hooks";
import { getDashboardConversationLink } from "@/chat/slack/dashboard-link";
import { escapeSlackMrkdwnText, formatSlackLink } from "@/chat/slack/mrkdwn";

interface SlackMrkdwnTextObject {
  text: string;
  type: "mrkdwn";
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
  elements: SlackMrkdwnTextObject[];
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
  items: SlackReplyFooterItem[];
}

/**
 * Build the compact conversation footer for visible Slack reply surfaces.
 *
 * Detailed turn metrics stay in the dashboard instead of Slack-visible copy.
 */
export function buildSlackReplyFooter(args: {
  conversationId?: string;
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

  return items.length > 0 ? { items } : undefined;
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

  if (footer?.items.length) {
    blocks.push({
      type: "context",
      elements: footer.items.map((item) => ({
        type: "mrkdwn",
        text: item.url
          ? `*${escapeSlackMrkdwnText(item.label)}:* ${formatSlackLink(item.url, item.value)}`
          : `*${escapeSlackMrkdwnText(item.label)}:* ${escapeSlackMrkdwnText(item.value)}`,
      })),
    });
  }

  return blocks;
}
