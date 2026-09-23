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
const storedCardSchema = z.union([
  ownedObjectAnnotationSchema,
  automationCardSchema.extend({
    operation: z.enum(["created", "updated", "deleted"]).optional(),
  }),
]);

/** Read saved cards without exposing obsolete operation receipts. */
export function readMessageCards(value: unknown): MessageCard[] {
  return storedCardSchema
    .array()
    .parse(value)
    .flatMap((card): MessageCard[] => {
      if (card.kind === "object") return [card];
      const { operation, ...snapshot } = card;
      return operation === "deleted" ? [] : [snapshot];
    });
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

/** Deduplicate selected objects across tools and explicit selections. */
export function messageCardKey(card: MessageCard): string {
  return card.kind === "object"
    ? JSON.stringify([card.plugin, card.key])
    : JSON.stringify(["junior", card.id]);
}

/** Identify an object card to select or omit from a reply. */
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
