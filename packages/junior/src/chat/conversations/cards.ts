import {
  objectFactFields,
  type ConversationAnnotation,
  type OwnedObjectAnnotation,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  automationCardSchema,
  automationCardText,
  type AutomationCard,
} from "@/chat/automations/card";

/** Facts for delivery and display. Messages store only references. */
export type MessageCard = OwnedObjectAnnotation | AutomationCard;

// Stored Messages can still contain receipt cards written before Work Objects.
const storedCardSchema = automationCardSchema.extend({
  operation: z.enum(["created", "updated", "deleted"]).optional(),
});

/** Render each built-in card with its own text format. */
export function messageCardText(card: MessageCard): string {
  switch (card.kind) {
    case "object":
      return [
        card.title,
        card.label !== card.title ? card.label : undefined,
        card.description,
        card.status,
        ...objectFactFields(card.facts).map(
          (field) => `${field.label}: ${field.value}`,
        ),
        card.trigger,
        card.warning,
        card.url,
      ]
        .filter(Boolean)
        .join("\n");
    case "automation":
      return automationCardText(card);
  }
}

/** Identify a deleted object whose pending card must be omitted. */
export const removedCardSchema = z
  .object({ plugin: z.string().min(1), key: z.string().min(1) })
  .strict();

/** Store only the annotation identity with a Message. */
export const messageCardRefSchema = removedCardSchema.extend({
  kind: z.literal("object"),
});
export type MessageCardRef = z.output<typeof messageCardRefSchema>;

/** Remove display facts before saving or reporting a Message card. */
export function messageCardRef(card: MessageCard): MessageCardRef {
  return card.kind === "object"
    ? { kind: "object", plugin: card.plugin, key: card.key }
    : { kind: "object", plugin: "junior", key: card.id };
}

/** Read references, including identities from older saved card snapshots. */
export function readMessageCardRefs(value: {
  cards?: unknown;
  objectCards?: unknown;
}): MessageCardRef[] {
  return [
    ...storedCardSchema
      .array()
      .parse(value.cards ?? [])
      .flatMap(({ operation, ...card }) =>
        operation === "deleted" ? [] : [messageCardRef(card)],
      ),
    ...messageCardRefSchema
      .strip()
      .array()
      .parse(value.objectCards ?? []),
  ];
}

/** Resolve current saved facts without fetching providers or changing history. */
export function resolveMessageCards(
  refs: readonly MessageCardRef[],
  annotations: readonly ConversationAnnotation[],
): OwnedObjectAnnotation[] {
  return refs.map((ref) => {
    const annotation = annotations.find(
      (item) =>
        item.kind === ref.kind &&
        item.plugin === ref.plugin &&
        item.key === ref.key,
    );
    return annotation
      ? annotationCard(annotation)
      : {
          ...ref,
          objectType: "item",
          title: ref.key,
          label: ref.key,
          url: null,
          warning: "Saved annotation is unavailable.",
        };
  });
}

/** Copy saved annotation facts without storage timestamps for Message delivery. */
export function annotationCard(
  annotation: ConversationAnnotation,
): OwnedObjectAnnotation {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...value } = annotation;
  return value.kind === "object"
    ? value
    : {
        ...value,
        kind: "object",
        objectType: value.objectType ?? "item",
        title: value.label,
      };
}
