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

/** Render each built-in card with its own text format. */
export function messageCardText(card: MessageCard): string {
  switch (card.kind) {
    case "automation":
      return automationCardText(card);
  }
}
