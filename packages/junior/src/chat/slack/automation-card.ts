import type { AutomationCard } from "@/chat/automations/card";
import type { SlackCard } from "./cards";
import { escapeSlackMrkdwnText, formatSlackLink } from "./mrkdwn";

function preview(text: string, length: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

/** Show an Automation as a native Work Object, not an operation receipt. */
export function renderSlackAutomationCard(
  card: Pick<AutomationCard, "id" | "title" | "url" | "trigger" | "warning"> & {
    status?: string;
  },
): SlackCard {
  const title = preview(card.title, 160);

  const trigger = preview(card.trigger, 500);
  const warning = card.warning ? preview(card.warning, 500) : null;
  const text = [
    card.url ? formatSlackLink(card.url, title) : escapeSlackMrkdwnText(title),
    card.status ? escapeSlackMrkdwnText(card.status) : null,
    escapeSlackMrkdwnText(trigger),
    warning ? escapeSlackMrkdwnText(warning) : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Work Objects need a real object URL. Do not invent one for headless installs.
  if (!card.url) return { entity: null, text };

  return {
    text,
    entity: {
      entity_type: "slack#/entities/item",
      external_ref: { id: card.id, type: "automation" },
      url: card.url,
      entity_payload: {
        attributes: {
          title: { text: title },
          display_type: "Automation",
        },
        custom_fields: [
          ...(card.status
            ? [
                {
                  key: "status",
                  label: "Status",
                  type: "string" as const,
                  value: card.status,
                },
              ]
            : []),
          {
            key: "trigger",
            label: "When",
            type: "string",
            value: trigger,
            long: true,
          },
          ...(warning
            ? [
                {
                  key: "warning",
                  label: "Needs attention",
                  type: "string" as const,
                  value: warning,
                  long: true,
                },
              ]
            : []),
        ],
      },
    },
  };
}
