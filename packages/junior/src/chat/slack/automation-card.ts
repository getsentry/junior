import type { AutomationCard } from "@/chat/automations/card";
import type { SlackMessageAttachment } from "./cards";
import type { SlackMessageBlock } from "./footer";
import { escapeSlackMrkdwnText, formatSlackLink } from "./mrkdwn";

function preview(text: string, length: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

/** Render a compact saved object, with full instructions left in the dashboard. */
export function renderSlackAutomationCard(
  card: AutomationCard,
): SlackMessageAttachment {
  const title = preview(card.title, 160);
  const trigger = preview(card.trigger, 250);
  const warning = card.warning ? preview(card.warning, 500) : null;
  const operation = `${card.operation[0]!.toUpperCase()}${card.operation.slice(1)}`;
  const url = card.operation === "deleted" ? null : card.url;
  const blocks: SlackMessageBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${url ? formatSlackLink(url, title) : escapeSlackMrkdwnText(title)}*`,
      },
    },
    {
      type: "context",
      elements: [
        { type: "plain_text", text: `Automation · ${operation}` },
        { type: "plain_text", text: trigger },
      ],
    },
    ...(warning
      ? [
          {
            type: "section" as const,
            text: { type: "plain_text" as const, text: `⚠ ${warning}` },
          },
        ]
      : []),
    {
      type: "context",
      elements: [{ type: "plain_text", text: `Automation ID: ${card.id}` }],
    },
  ];
  return {
    blocks,
    ...(warning ? { color: "warning" } : undefined),
    fallback: escapeSlackMrkdwnText(
      [
        `${title} — ${operation}`,
        trigger,
        warning,
        url,
        `Automation ID: ${card.id}`,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  };
}
