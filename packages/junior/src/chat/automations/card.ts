import * as z from "zod";

/** Saved automation facts shown with a Message, not a live status view. */
export const automationCardSchema = z
  .object({
    kind: z.literal("automation"),
    id: z.string().min(1),
    title: z.string().min(1).max(160),
    url: z.string().url().nullable(),
    instruction: z.string().max(4000),
    trigger: z.string().min(1),
    warning: z.string().nullable(),
  })
  .strict();

export type AutomationCard = z.output<typeof automationCardSchema>;

/** Render saved card facts for text-only delivery and accessible fallbacks. */
export function automationCardText(card: AutomationCard): string {
  return [
    card.title,
    card.warning,
    card.trigger,
    card.instruction,
    card.url,
    `Automation ID: ${card.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Return the status and warning that the card and the Slack details of an
 * Automation show. The status is the saved status, except that an active
 * Automation whose trigger cannot work shows as unavailable. Only a block or
 * a trigger problem gives a warning, like Needs attention in `collection.ts`.
 */
export function automationCardStatus(automation: {
  status: string;
  statusReason?: string | null | undefined;
  triggerProblems?: readonly string[] | undefined;
}): { status: string; warning: string | undefined } {
  const problems = automation.triggerProblems ?? [];
  const warning = [
    automation.status === "blocked"
      ? (automation.statusReason ?? "This automation is blocked.")
      : undefined,
    problems.length > 0
      ? ["Trigger unavailable.", ...problems].join(" ")
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    status:
      automation.status === "active" && problems.length > 0
        ? "unavailable"
        : automation.status,
    warning: warning || undefined,
  };
}
