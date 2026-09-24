import type { OwnedObjectAnnotation } from "@sentry/junior-plugin-api";
import type { SlackCard } from "./cards";
import { renderSlackAutomationCard } from "./automation-card";
import { escapeSlackMrkdwnText, formatSlackLink } from "./mrkdwn";

/** Render verified annotation facts as a native Task or Item preview. */
export function renderSlackObjectCard(card: OwnedObjectAnnotation): SlackCard {
  if (card.objectType === "automation" && card.plugin === "junior") {
    return renderSlackAutomationCard({
      id: card.key,
      title: card.title,
      url: card.url,
      trigger: card.trigger ?? "",
      warning: card.warning ?? null,
    });
  }
  const title = card.title.slice(0, 160);
  const text = [
    card.url ? formatSlackLink(card.url, title) : escapeSlackMrkdwnText(title),
    escapeSlackMrkdwnText(card.label),
    card.status ? escapeSlackMrkdwnText(card.status) : null,
  ]
    .filter(Boolean)
    .join("\n");
  if (!card.url) return { entity: null, text };
  const task = card.objectType === "task";
  return {
    text,
    entity: {
      entity_type: task ? "slack#/entities/task" : "slack#/entities/item",
      external_ref: {
        id: JSON.stringify([card.plugin, card.key]),
        type: "annotation",
      },
      url: card.url,
      entity_payload: {
        attributes: {
          title: { text: title },
          display_id: card.label,
          display_type:
            card.objectType === "code_change"
              ? "Pull request"
              : task
                ? "Issue"
                : "Item",
          product_name: card.plugin,
        },
        fields:
          task && card.status ? { status: { value: card.status } } : undefined,
        custom_fields:
          !task && card.status
            ? [
                {
                  key: "status",
                  label: "Status",
                  type: "string",
                  value: card.status,
                },
              ]
            : [],
      },
    },
  };
}
