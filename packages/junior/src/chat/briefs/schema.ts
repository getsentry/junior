/**
 * Runtime schemas for the Brief record and the generator input. Both cross a
 * durable or CLI edge, so these schemas own the exported types.
 */
import {
  codeChangeStateSchema,
  pluginBriefDecisionKindSchema,
  pluginBriefLineSchema,
  pluginBriefOutcomeStatusSchema,
  pluginBriefSummarySchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

const lineSchema = pluginBriefLineSchema;
const urlSchema = z.string().url().max(2_048);
const timestampSchema = z.string().datetime();

const briefLocationSchema = z
  .object({
    provider: z.string().trim().min(1).max(100),
    channelName: lineSchema.optional(),
  })
  .strict();

export const briefOutcomeStatusSchema = pluginBriefOutcomeStatusSchema;

export const briefCodeChangeSchema = z
  .object({
    repository: lineSchema,
    number: z.number().int().positive(),
    title: lineSchema.optional(),
    url: urlSchema,
    state: codeChangeStateSchema,
    openedAt: timestampSchema.optional(),
    mergedAt: timestampSchema.optional(),
    closedAt: timestampSchema.optional(),
  })
  .strict();

export const briefLinkSchema = z
  .object({
    kind: z.enum(["code_change", "resource", "url"]),
    label: lineSchema,
    url: urlSchema,
    status: lineSchema.optional(),
  })
  .strict();

const briefRecordSchema = z
  .object({
    startedAt: timestampSchema,
    lastActivityAt: timestampSchema,
    durationMs: z.number().int().nonnegative(),
    participants: z.array(
      z
        .object({
          name: lineSchema,
          messages: z.number().int().positive(),
        })
        .strict(),
    ),
    userMessages: z.number().int().nonnegative(),
    assistantMessages: z.number().int().nonnegative(),
    toolResults: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    turns: z.number().int().positive().optional(),
    location: briefLocationSchema.optional(),
    codeChanges: z.array(briefCodeChangeSchema),
  })
  .strict();

export const conversationBriefSchema = z
  .object({
    schemaVersion: z.literal(1),
    record: briefRecordSchema,
    summary: pluginBriefSummarySchema,
    intent: lineSchema,
    outcome: z
      .object({
        status: briefOutcomeStatusSchema,
        text: pluginBriefSummarySchema,
      })
      .strict(),
    decisions: z
      .array(
        z
          .object({
            text: lineSchema,
            by: lineSchema.optional(),
            kind: pluginBriefDecisionKindSchema,
          })
          .strict(),
      )
      .max(20),
    openDecisions: z
      .array(
        z
          .object({
            text: lineSchema,
            owner: lineSchema.optional(),
          })
          .strict(),
      )
      .max(20),
    facts: z.array(lineSchema).max(30),
    links: z.array(briefLinkSchema).max(40),
    keywords: z.array(z.string().trim().toLowerCase().min(1).max(400)).max(12),
  })
  .strict();

export type BriefOutcomeStatus = z.output<typeof briefOutcomeStatusSchema>;
export type BriefCodeChange = z.output<typeof briefCodeChangeSchema>;
export type BriefLink = z.output<typeof briefLinkSchema>;
export type ConversationBrief = z.output<typeof conversationBriefSchema>;

const briefEntrySchema = z
  .object({
    index: z.number().int().nonnegative(),
    role: z.enum(["user", "assistant", "tool", "event"]),
    author: lineSchema.optional(),
    text: z.string().min(1),
    createdAtMs: z.number().int().nonnegative(),
    turnId: z.string().min(1).optional(),
  })
  .strict();

const briefResourceSchema = z
  .object({
    label: lineSchema,
    url: urlSchema,
    status: lineSchema.optional(),
  })
  .strict();

const briefInputSchema = z
  .object({
    conversationId: z.string().min(1),
    title: lineSchema.optional(),
    visibility: z.enum(["private", "public"]),
    location: briefLocationSchema.optional(),
    entries: z.array(briefEntrySchema),
    codeChanges: z.array(briefCodeChangeSchema),
    resources: z.array(briefResourceSchema),
  })
  .strict();

export type BriefEntry = z.output<typeof briefEntrySchema>;
export type BriefResource = z.output<typeof briefResourceSchema>;
export type BriefInput = z.output<typeof briefInputSchema>;

/** Parse the provider-neutral input used by every Brief generator adapter. */
export function parseBriefInput(input: unknown): BriefInput {
  const parsed = briefInputSchema.parse(input);
  return {
    ...parsed,
    entries: [...parsed.entries].sort(
      (left, right) =>
        left.index - right.index || left.createdAtMs - right.createdAtMs,
    ),
  };
}
