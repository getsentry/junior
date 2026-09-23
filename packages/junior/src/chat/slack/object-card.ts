import type { OwnedObjectAnnotation } from "@sentry/junior-plugin-api";
import type { SlackCard } from "./cards";
import { escapeSlackMrkdwnText, formatSlackLink } from "./mrkdwn";

/** Render verified annotation facts as a native Task or Item preview. */
export function renderSlackObjectCard(
  card: OwnedObjectAnnotation,
  conversationId: string,
): SlackCard {
  const title = card.title.slice(0, 160);
  const fields = card.fields ?? [];
  const text = [
    card.url ? formatSlackLink(card.url, title) : escapeSlackMrkdwnText(title),
    escapeSlackMrkdwnText(card.label),
    card.status ? escapeSlackMrkdwnText(card.status) : null,
    ...fields.map((field) =>
      escapeSlackMrkdwnText(`${field.label}: ${field.value}`),
    ),
  ]
    .filter(Boolean)
    .join("\n");
  if (!card.url) return { entity: null, text };
  const task = card.objectType === "task";
  const automation =
    card.objectType === "automation" && card.plugin === "junior";
  return {
    text,
    entity: {
      entity_type: task ? "slack#/entities/task" : "slack#/entities/item",
      external_ref: automation
        ? { id: card.key, type: "automation" }
        : {
            id: JSON.stringify([conversationId, card.plugin, card.key]),
            type: "annotation",
          },
      url: card.url,
      entity_payload: {
        attributes: {
          title: { text: title },
          display_id: automation ? undefined : card.label,
          display_type:
            card.objectType === "code_change"
              ? "Pull request"
              : automation
                ? "Automation"
                : task
                  ? "Issue"
                  : "Item",
          product_name: automation ? undefined : card.plugin,
        },
        fields:
          task && card.status ? { status: { value: card.status } } : undefined,
        custom_fields: [
          ...(!task && card.status
            ? [
                {
                  key: "status",
                  label: "Status",
                  type: "string",
                  value: card.status,
                },
              ]
            : []),
          ...fields.map((field, index) => ({
            key: `field_${index}`,
            label: field.label,
            type: "string",
            value: field.value.slice(0, 500),
            long: true,
          })),
        ],
      },
    },
  };
}
