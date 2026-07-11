import { z } from "zod";
import {
  actorIdentitySchema,
  conversationStatsItemSchema,
  conversationSummaryReportSchema,
} from "../conversations/schema";

export const peopleConversationSummaryReportSchema =
  conversationSummaryReportSchema.omit({
    cumulativeUsage: true,
    sentryTraceUrl: true,
    traceId: true,
  });

export const peopleConversationStatsItemSchema =
  conversationStatsItemSchema.omit({ costUsd: true });

export const actorActivityDayReportSchema = z
  .object({
    active: z.number(),
    conversations: z.number(),
    date: z.string(),
    durationMs: z.number(),
    failed: z.number(),
    hung: z.number(),
    tokens: z.number().optional(),
  })
  .strict();

export const actorTotalsReportSchema = z
  .object({
    active: z.number(),
    activeDays: z.number(),
    conversations: z.number(),
    durationMs: z.number(),
    failed: z.number(),
    hung: z.number(),
    tokens: z.number().optional(),
  })
  .strict();

export const identifiedActorSchema = actorIdentitySchema
  .extend({ email: z.string().min(1) })
  .strict();

export const actorSummaryReportSchema = actorTotalsReportSchema
  .extend({
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    actor: identifiedActorSchema,
  })
  .strict();

export const actorDirectoryReportSchema = z
  .object({
    generatedAt: z.string(),
    people: z.array(actorSummaryReportSchema),
    sampleLimit: z.number(),
    sampleSize: z.number(),
    source: z.literal("conversation_index"),
    truncated: z.boolean(),
  })
  .strict();

export const actorProfileReportSchema = z
  .object({
    activityDays: z.array(actorActivityDayReportSchema),
    generatedAt: z.string(),
    locations: z.array(peopleConversationStatsItemSchema),
    recentConversations: z.array(peopleConversationSummaryReportSchema),
    actor: identifiedActorSchema,
    sampleLimit: z.number(),
    sampleSize: z.number(),
    source: z.literal("conversation_index"),
    surfaces: z.array(peopleConversationStatsItemSchema),
    totals: actorTotalsReportSchema,
    truncated: z.boolean(),
    windowEnd: z.string(),
    windowStart: z.string(),
  })
  .strict();

export type ActorIdentity = z.infer<typeof actorIdentitySchema>;
export type ConversationSummaryReport = z.infer<
  typeof peopleConversationSummaryReportSchema
>;
export type ConversationStatsItem = z.infer<
  typeof peopleConversationStatsItemSchema
>;
export type ActorActivityDayReport = z.infer<
  typeof actorActivityDayReportSchema
>;
export type ActorTotalsReport = z.infer<typeof actorTotalsReportSchema>;
export type ActorSummaryReport = z.infer<typeof actorSummaryReportSchema>;
export type ActorDirectoryReport = z.infer<typeof actorDirectoryReportSchema>;
export type ActorProfileReport = z.infer<typeof actorProfileReportSchema>;
