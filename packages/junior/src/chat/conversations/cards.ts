import { z } from "zod";
import {
  automationCardSchema,
  automationCardText,
} from "@/chat/automations/card";

/** Built-in response types accepted by Message storage and delivery. */
export const messageCardSchema = z.discriminatedUnion("kind", [
  automationCardSchema,
]);
export type MessageCard = z.output<typeof messageCardSchema>;

// Stored Messages can still contain receipt cards written before Work Objects.
const storedCardSchema = automationCardSchema.extend({
  operation: z.enum(["created", "updated", "deleted"]).optional(),
});

/** Read saved cards without exposing obsolete operation receipts. */
export function readMessageCards(value: unknown): MessageCard[] {
  return storedCardSchema
    .array()
    .parse(value)
    .flatMap(({ operation, ...card }) =>
      operation === "deleted" ? [] : [card],
    );
}

/** Render each built-in card with its own text format. */
export function messageCardText(card: MessageCard): string {
  switch (card.kind) {
    case "automation":
      return automationCardText(card);
  }
}
