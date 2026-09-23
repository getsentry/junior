import {
  ownedObjectAnnotationSchema,
  type ConversationAnnotation,
  type OwnedObjectAnnotation,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  automationCardSchema,
  automationCardText,
} from "@/chat/automations/card";

/** Built-in response types accepted by Message storage and delivery. */
export const messageCardSchema = z.discriminatedUnion("kind", [
  automationCardSchema,
  ownedObjectAnnotationSchema,
]);
export type MessageCard = z.output<typeof messageCardSchema>;

// Stored Messages can still contain receipt cards written before Work Objects.
const storedCardSchema = automationCardSchema.extend({
  operation: z.enum(["created", "updated", "deleted"]).optional(),
});

/** Read both stored formats while keeping new objects out of the legacy field. */
export function readMessageCards(value: {
  cards?: unknown;
  objectCards?: unknown;
}): MessageCard[] {
  return [
    ...storedCardSchema
      .array()
      .parse(value.cards ?? [])
      .flatMap(({ operation, ...card }) =>
        operation === "deleted" ? [] : [card],
      ),
    ...ownedObjectAnnotationSchema.array().parse(value.objectCards ?? []),
  ];
}

/** Render each built-in card with its own text format. */
export function messageCardText(card: MessageCard): string {
  switch (card.kind) {
    case "object":
      return [
        card.title,
        card.label,
        card.status,
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

/** Deduplicate object cards across successful tool results. */
export function messageCardKey(card: MessageCard): string {
  return card.kind === "object"
    ? JSON.stringify([card.plugin, card.key])
    : JSON.stringify(["junior", card.id]);
}

/** Identify a deleted object whose pending card must be omitted. */
export const messageCardRefSchema = z
  .object({ plugin: z.string().min(1), key: z.string().min(1) })
  .strict();

/** Copy saved annotation facts without storage timestamps for Message delivery. */
export function annotationCard(
  annotation: ConversationAnnotation,
): OwnedObjectAnnotation {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...value } = annotation;
  return value.kind === "object"
    ? value
    : { ...value, kind: "object", objectType: "item", title: value.label };
}
