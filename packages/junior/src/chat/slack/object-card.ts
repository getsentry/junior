import { getDashboardObjectIconLink } from "@/chat/dashboard-link";
import {
  objectFactFields,
  objectPresentation,
  type OwnedObjectAnnotation,
} from "@sentry/junior-plugin-api";
import type { SlackCard } from "./cards";
import type { SlackEntity } from "./work-object";
import { renderSlackAutomationCard } from "./automation-card";
import { escapeSlackMrkdwnText, formatSlackLink } from "./mrkdwn";

function descriptionPreview(value: string | undefined): string {
  const text = value?.replace(/\r\n/g, "\n").trim() ?? "";
  const preview = text.split("\n").slice(0, 6).join("\n").slice(0, 500);
  return preview.length < text.length
    ? `${preview.slice(0, 499).trimEnd()}…`
    : preview;
}

/** Render a compact Task or Item preview, or the saved facts for its detail panel. */
export function renderSlackObjectCard(
  card: OwnedObjectAnnotation,
  conversationId: string,
  surface: "preview" | "details" = "preview",
): SlackCard {
  if (card.objectType === "automation" && card.plugin === "junior") {
    return renderSlackAutomationCard({
      id: card.key,
      title: card.title,
      url: card.url,
      trigger: card.trigger ?? "",
      warning: card.warning ?? null,
    });
  }
  const presentation = objectPresentation(card);
  const type = card.displayType ?? presentation.label;
  const iconUrl = getDashboardObjectIconLink(presentation.icon);
  const title = card.title.slice(0, 160);
  const details = surface === "details";
  // Deployment state is the result. Other previews show content, not bookkeeping.
  const deployment =
    card.objectType === "deployment" ||
    (card.objectType === "item" && card.facts?.type === "deployment");
  // Calendar event previews show the time, attendees, and a cancellation, not
  // the agenda.
  const calendarEvent = card.objectType === "calendar_event";
  const status =
    details || deployment || calendarEvent ? card.status : undefined;
  const warning = details || deployment ? card.warning : undefined;
  const facts = objectFactFields(card.facts).filter(
    (field) =>
      details || calendarEvent || (deployment && field.key === "environment"),
  );
  const description = details
    ? (card.description?.trim() ?? "")
    : calendarEvent
      ? ""
      : descriptionPreview(card.description);
  const text = [
    escapeSlackMrkdwnText(type),
    card.url ? formatSlackLink(card.url, title) : escapeSlackMrkdwnText(title),
    escapeSlackMrkdwnText(card.label),
    status ? escapeSlackMrkdwnText(status) : null,
    description ? escapeSlackMrkdwnText(description) : null,
    warning ? escapeSlackMrkdwnText(`Needs attention: ${warning}`) : null,
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
    display_type: type,
    product_icon: iconUrl
      ? {
          url: iconUrl,
          alt_text: `${type}${status ? `: ${status}` : ""}`,
        }
      : undefined,
    product_name: card.plugin,
  };
  const customFields = [
    ...(description
      ? [
          {
            key: "description",
            label: "Description",
            type: "string" as const,
            value: description,
            long: true,
            format: "markdown" as const,
          },
        ]
      : []),
    ...facts.map((field) => ({ ...field, type: "string" as const })),
    ...(warning
      ? [
          {
            key: "warning",
            label: "Needs attention",
            type: "string" as const,
            value: warning,
          },
        ]
      : []),
  ];
  const entity: SlackEntity = {
    ...(task
      ? {
          entity_type: "slack#/entities/task",
          entity_payload: {
            attributes,
            display_order: [
              ...(status ? ["status"] : []),
              ...customFields.map((field) => field.key),
            ],
            fields: status ? { status: { value: status } } : undefined,
            custom_fields: customFields,
          },
        }
      : {
          entity_type: "slack#/entities/item",
          entity_payload: {
            attributes,
            display_order: [
              ...(status ? ["status"] : []),
              ...customFields.map((field) => field.key),
            ],
            custom_fields: [
              ...(status
                ? [
                    {
                      key: "status",
                      label: "Status",
                      type: "string" as const,
                      value: status,
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
