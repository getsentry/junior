import { z } from "zod";

/** Saved automation facts shown with a Message, not a live status view. */
export const automationCardSchema = z
  .object({
    kind: z.literal("automation"),
    id: z.string().min(1),
    title: z.string().min(1).max(160),
    url: z.string().url().nullable(),
    operation: z.enum(["created", "updated", "deleted"]),
    instruction: z.string().max(4000),
    trigger: z.string().min(1),
    warning: z.string().nullable(),
  })
  .strict();

export type AutomationCard = z.output<typeof automationCardSchema>;

/** Render saved card facts for text-only delivery and accessible fallbacks. */
export function automationCardText(card: AutomationCard): string {
  return [
    `${card.title} — ${card.operation}`,
    card.warning,
    card.trigger,
    card.instruction,
    card.url,
    `Automation ID: ${card.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}
