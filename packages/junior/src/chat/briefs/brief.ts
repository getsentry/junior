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

export const briefRecordSchema = z
  .object({
    startedAt: z.string().datetime(),
    lastActivityAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    participants: z.array(
      z
        .object({
          name: z.string().trim().min(1).max(400),
          messages: z.number().int().positive(),
        })
        .strict(),
    ),
    userMessages: z.number().int().nonnegative(),
    assistantMessages: z.number().int().nonnegative(),
    toolResults: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    turns: z.number().int().positive().optional(),
    location: z
      .object({
        provider: z.string().trim().min(1).max(100),
        channelName: z.string().trim().min(1).max(400).optional(),
      })
      .strict()
      .optional(),
    codeChanges: z.array(
      z
        .object({
          repository: z.string().trim().min(1).max(400),
          number: z.number().int().positive(),
          title: z.string().trim().min(1).max(400).optional(),
          url: z.string().url().max(2_048),
          state: z.enum(["closed", "merged", "open"]),
          openedAt: z.string().datetime().optional(),
          mergedAt: z.string().datetime().optional(),
          closedAt: z.string().datetime().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const conversationBriefSchema = z
  .object({
    schemaVersion: z.literal(1),
    record: briefRecordSchema,
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
            kind: z.enum(["stated", "confirmed", "assumed"]),
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
    ...brief.record.participants.map((participant) => participant.name),
    ...brief.record.codeChanges.map(
      (change) => `${change.repository}#${change.number} ${change.state}`,
    ),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
}
