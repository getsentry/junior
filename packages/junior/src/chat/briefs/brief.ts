import { z } from "zod";

export const briefOutcomeStatusSchema = z.enum([
  "in_progress",
  "answered",
  "done",
  "partial",
  "blocked",
  "abandoned",
]);

export const briefLinkSchema = z
  .object({
    kind: z.enum(["code_change", "resource", "url"]),
    label: z.string().trim().min(1).max(400),
    url: z.string().url().max(2_048),
    status: z.string().trim().min(1).max(400).optional(),
  })
  .strict();

export const conversationBriefSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: z.string().trim().min(1).max(600),
    intent: z.string().trim().min(1).max(400),
    outcome: z
      .object({
        status: briefOutcomeStatusSchema,
        text: z.string().trim().min(1).max(600),
      })
      .strict(),
    decisions: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(400),
            by: z.string().trim().min(1).max(400).optional(),
          })
          .strict(),
      )
      .max(20),
    openDecisions: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(400),
            owner: z.string().trim().min(1).max(400).optional(),
          })
          .strict(),
      )
      .max(20),
    facts: z.array(z.string().trim().min(1).max(400)).max(30),
    links: z.array(briefLinkSchema).max(40),
    keywords: z.array(z.string().trim().toLowerCase().min(1).max(400)).max(12),
  })
  .strict();

export type BriefOutcomeStatus = z.output<typeof briefOutcomeStatusSchema>;
export type BriefLink = z.output<typeof briefLinkSchema>;
export type ConversationBrief = z.output<typeof conversationBriefSchema>;

/** Build the text indexed for a Brief without adding transcript content. */
export function buildBriefSearchText(
  brief: ConversationBrief,
  title?: string,
): string {
  return [
    title,
    brief.summary,
    brief.intent,
    brief.outcome.text,
    ...brief.decisions.map((decision) => decision.text),
    ...brief.openDecisions.map((decision) => decision.text),
    ...brief.facts,
    ...brief.keywords,
    ...brief.links.map((link) => link.label),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
}
