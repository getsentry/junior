import {
  extractFirstMarkdownTable,
  type MarkdownTableMatch,
} from "@/chat/slack/markdown-table";
import { type SlackReplyFooter } from "@/chat/slack/footer";
import { renderSlackMrkdwn } from "@/chat/slack/mrkdwn";

interface SlackMrkdwnTextObject {
  text: string;
  type: "mrkdwn";
}

interface SlackRawTextTableCell {
  text: string;
  type: "raw_text";
}

interface SlackRichTextLinkElement {
  text: string;
  type: "link";
  url: string;
}

interface SlackRichTextTextElement {
  text: string;
  type: "text";
}

interface SlackRichTextSection {
  elements: Array<SlackRichTextLinkElement | SlackRichTextTextElement>;
  type: "rich_text_section";
}

interface SlackRichTextTableCell {
  elements: SlackRichTextSection[];
  type: "rich_text";
}

interface SlackSectionBlock {
  expand?: boolean;
  text: SlackMrkdwnTextObject;
  type: "section";
}

interface SlackContextBlock {
  elements: SlackMrkdwnTextObject[];
  type: "context";
}

interface SlackTableBlock {
  rows: Array<Array<SlackRawTextTableCell | SlackRichTextTableCell>>;
  type: "table";
}

export type SlackMessageBlock =
  | SlackSectionBlock
  | SlackContextBlock
  | SlackTableBlock;

function escapeSlackMrkdwn(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildBodySection(text: string): SlackSectionBlock {
  return {
    type: "section",
    expand: true,
    text: {
      type: "mrkdwn",
      text,
    },
  };
}

function buildFooterBlock(
  footer: SlackReplyFooter | undefined,
): SlackContextBlock | undefined {
  if (!footer?.items.length) {
    return undefined;
  }

  return {
    type: "context",
    elements: footer.items.map((item) => ({
      type: "mrkdwn",
      text: `*${escapeSlackMrkdwn(item.label)}:* ${escapeSlackMrkdwn(item.value)}`,
    })),
  };
}

function decodeSlackEntities(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function buildTableCell(
  cell: string,
): SlackRawTextTableCell | SlackRichTextTableCell {
  const normalized = renderSlackMrkdwn(cell);
  const linkPattern = /<(https?:\/\/[^>|]+)(?:\|([^>]+))?>/g;
  const elements: Array<SlackRichTextLinkElement | SlackRichTextTextElement> =
    [];
  let lastIndex = 0;

  for (const match of normalized.matchAll(linkPattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      elements.push({
        type: "text",
        text: decodeSlackEntities(normalized.slice(lastIndex, index)),
      });
    }

    elements.push({
      type: "link",
      url: match[1] ?? "",
      text: decodeSlackEntities(match[2] ?? match[1] ?? ""),
    });
    lastIndex = index + match[0].length;
  }

  if (elements.length === 0) {
    return {
      type: "raw_text",
      text: decodeSlackEntities(normalized),
    };
  }

  if (lastIndex < normalized.length) {
    elements.push({
      type: "text",
      text: decodeSlackEntities(normalized.slice(lastIndex)),
    });
  }

  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements,
      },
    ],
  };
}

function buildSlackTableBlock(match: MarkdownTableMatch): SlackMessageBlock[] {
  const blocks: SlackMessageBlock[] = [];
  const before = renderSlackMrkdwn(match.before).trim();
  if (before) {
    blocks.push(buildBodySection(before));
  }

  blocks.push({
    type: "table",
    rows: match.rows.map((row) => row.map(buildTableCell)),
  });

  const after = renderSlackMrkdwn(match.after).trim();
  if (after) {
    blocks.push(buildBodySection(after));
  }

  return blocks;
}

/**
 * Build Slack blocks for a finalized reply, upgrading a single markdown table to
 * a native Slack table block when the original source text still contains one.
 */
export function buildSlackReplyBlocks(
  text: string,
  footer: SlackReplyFooter | undefined,
  options?: {
    richSourceText?: string;
  },
): SlackMessageBlock[] | undefined {
  if (!text.trim()) {
    return undefined;
  }

  const bodyBlocks = (() => {
    const match = options?.richSourceText
      ? extractFirstMarkdownTable(options.richSourceText)
      : null;
    if (!match) {
      return [buildBodySection(text)];
    }
    return buildSlackTableBlock(match);
  })();

  const footerBlock = buildFooterBlock(footer);
  return footerBlock ? [...bodyBlocks, footerBlock] : bodyBlocks;
}
