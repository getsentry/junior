import {
  objectFactFields,
  type OwnedObjectAnnotation,
} from "@sentry/junior-plugin-api";
import type { SlackCard } from "./cards";
import type { SlackEntity } from "./work-object";
import { renderSlackAutomationCard } from "./automation-card";
import { escapeSlackMrkdwnText, formatSlackLink } from "./mrkdwn";

/** Render verified annotation facts as a native Task or Item preview. */
export function renderSlackObjectCard(
  card: OwnedObjectAnnotation,
  conversationId: string,
): SlackCard {
  if (card.objectType === "automation" && card.plugin === "junior") {
    return renderSlackAutomationCard({
      id: card.key,
      title: card.title,
      url: card.url,
      trigger: card.trigger ?? "",
      warning: card.warning ?? null,
      status: card.status,
    });
  }
  const title = card.title.slice(0, 160);
  const facts = objectFactFields(card.facts);
  const text = [
    card.url ? formatSlackLink(card.url, title) : escapeSlackMrkdwnText(title),
    escapeSlackMrkdwnText(card.label),
    card.status ? escapeSlackMrkdwnText(card.status) : null,
    ...facts.map((field) =>
      escapeSlackMrkdwnText(`${field.label}: ${field.value}`),
    ),
  ]
    .filter(Boolean)
    .join("\n");
  if (!card.url) return { entity: null, text };
  const task = card.objectType === "task";
  const attributes = {
    title: { text: title },
    display_id: card.label,
    display_type:
      card.displayType ??
      (card.objectType === "code_change"
        ? "Pull request"
        : task
          ? "Issue"
          : "Item"),
    product_name: card.plugin,
  };
  const customFields = facts.map((field) => ({
    ...field,
    type: "string" as const,
  }));
  if (card.sourceUpdatedAt)
    customFields.push({
      key: "sourceUpdatedAt",
      label: "Source updated",
      type: "string" as const,
      value: card.sourceUpdatedAt,
    });
  const entity: SlackEntity = {
    ...(task
      ? {
          entity_type: "slack#/entities/task",
          entity_payload: {
            attributes,
            display_order: [
              ...(card.status ? ["status"] : []),
              ...customFields.map((field) => field.key),
            ],
            fields: card.status
              ? { status: { value: card.status } }
              : undefined,
            custom_fields: customFields,
          },
        }
      : {
          entity_type: "slack#/entities/item",
          entity_payload: {
            attributes,
            display_order: [
              ...(card.status ? ["status"] : []),
              ...customFields.map((field) => field.key),
            ],
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
              ...customFields,
            ],
          },
        }),
    external_ref: {
      id: Buffer.from(
        JSON.stringify([conversationId, card.plugin, card.key]),
        "utf8",
      ).toString("base64url"),
      type: "annotation",
    },
    url: card.url,
  };
  return { text, entity };
}
