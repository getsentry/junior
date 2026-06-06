import { buildSentryConversationUrl } from "@/chat/sentry-links";
import { getAgentPluginSlackConversationLink } from "@/chat/plugins/agent-hooks";

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

function escapeSlackMrkdwn(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeSlackLinkUrl(url: string): string {
  return url
    .replaceAll("&", "&amp;")
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E");
}

/**
 * Build the compact conversation footer for the finalized Slack reply.
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
      getAgentPluginSlackConversationLink(conversationId)?.url ??
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
          ? `*${escapeSlackMrkdwn(item.label)}:* <${escapeSlackLinkUrl(item.url)}|${escapeSlackMrkdwn(item.value)}>`
          : `*${escapeSlackMrkdwn(item.label)}:* ${escapeSlackMrkdwn(item.value)}`,
      })),
    });
  }

  return blocks;
}
