import { messageCardText, type MessageCard } from "@/chat/conversations/cards";
import type { SlackMessageBlock } from "./footer";
import { escapeSlackMrkdwnText } from "./mrkdwn";

function preview(text: string, length: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

/** Render saved card facts with Slack layout, not model-generated blocks. */
export function renderSlackCard(card: MessageCard): {
  blocks: SlackMessageBlock[];
  text: string;
} {
  const summary = {
    ...card,
    instruction: preview(card.instruction, 300),
    trigger: preview(card.trigger, 250),
    warning: card.warning ? preview(card.warning, 500) : null,
  };
  const blocks: SlackMessageBlock[] = [
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${escapeSlackMrkdwnText(card.title)}*` },
      ...(card.url && card.operation !== "deleted"
        ? {
            accessory: {
              type: "button" as const,
              text: { type: "plain_text" as const, text: "Open automation" },
              url: card.url,
              action_id: "open_automation",
            },
          }
        : undefined),
    },
    ...(card.warning
      ? [
          {
            type: "section" as const,
            text: {
              type: "plain_text" as const,
              text: `⚠ ${summary.warning}`,
            },
          },
        ]
      : []),
    {
      type: "section",
      text: {
        type: "plain_text",
        text: summary.instruction,
      },
    },
    {
      type: "context",
      elements: [{ type: "plain_text", text: summary.trigger }],
    },
    {
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: `${card.operation[0]!.toUpperCase()}${card.operation.slice(1)} · Automation ID: ${card.id}`,
        },
      ],
    },
  ];
  return { blocks, text: escapeSlackMrkdwnText(messageCardText(summary)) };
}
