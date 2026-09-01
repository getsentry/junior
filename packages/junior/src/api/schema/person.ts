import { z } from "zod";
import {
  actorIdentitySchema,
  conversationStatsItemSchema,
  conversationSummaryReportSchema,
} from "./conversation";

export const personParamsSchema = z
  .object({ email: z.string().trim().min(1) })
  .strict();

export const peopleConversationStatsItemSchema =
  conversationStatsItemSchema.omit({ costUsd: true });

/** UTC day (`YYYY-MM-DD`) or hour (`YYYY-MM-DDTHH`) activity bucket key. */
export const peopleMetricBucketSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2})?$/);

export const actorActivityDayReportSchema = z
  .object({
    active: z.number(),
    conversations: z.number(),
    costUsd: z.number().optional(),
    date: peopleMetricBucketSchema,
    durationMs: z.number(),
    failed: z.number(),
    tokens: z.number().optional(),
  })
  .strict();

export const peopleActivityDayReportSchema = z
  .object({
    activePeople: z.number(),
    conversations: z.number(),
    date: peopleMetricBucketSchema,
  })
  .strict();

export const actorTotalsReportSchema = z
  .object({
    active: z.number(),
    activeDays: z.number(),
    conversations: z.number(),
    durationMs: z.number(),
    failed: z.number(),
    tokens: z.number().optional(),
  })
  .strict();

/** Spend and activity for one people-directory range, plus the prior period's spend. */
export const actorWindowMetricsSchema = z
  .object({
    conversations: z.number().int().nonnegative(),
    costUsd: z.number().finite().nonnegative(),
    durationMs: z.number().finite().nonnegative(),
    priorCostUsd: z.number().finite().nonnegative(),
  })
  .strict();

/** People-directory ranges that match the dashboard range control. */
export const actorDirectoryWindowsSchema = z
  .object({
    1: actorWindowMetricsSchema,
    7: actorWindowMetricsSchema,
    30: actorWindowMetricsSchema,
    90: actorWindowMetricsSchema,
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
    windows: actorDirectoryWindowsSchema,
  })
  .strict();

export const actorDirectoryReportSchema = z
  .object({
    activityDays: z.array(peopleActivityDayReportSchema),
    activityHours: z.array(peopleActivityDayReportSchema).optional(),
    activitySixHours: z.array(peopleActivityDayReportSchema).optional(),
    generatedAt: z.string(),
    people: z.array(actorSummaryReportSchema),
    source: z.literal("conversation_index"),
    windowEnd: z.string(),
    windowStart: z.string(),
  })
  .strict();

export const actorProfileReportSchema = z
  .object({
    activityDays: z.array(actorActivityDayReportSchema),
    activityHours: z.array(actorActivityDayReportSchema).optional(),
    activitySixHours: z.array(actorActivityDayReportSchema).optional(),
    generatedAt: z.string(),
    locations: z.array(peopleConversationStatsItemSchema),
    recentConversations: z.array(conversationSummaryReportSchema),
    actor: identifiedActorSchema,
    source: z.literal("conversation_index"),
    surfaces: z.array(peopleConversationStatsItemSchema),
    totals: actorTotalsReportSchema,
    windowEnd: z.string(),
    windowStart: z.string(),
  })
  .strict();

export const personalSpendReportSchema = z
  .object({
    generatedAt: z.string(),
    sevenDaysUsd: z.number().finite().nonnegative(),
    source: z.literal("conversation_index"),
    thirtyDaysUsd: z.number().finite().nonnegative(),
    windowEnd: z.string(),
    windowStart: z.string(),
  })
  .strict();

export type ActorIdentity = z.infer<typeof actorIdentitySchema>;
export type ConversationSummaryReport = z.infer<
  typeof conversationSummaryReportSchema
>;
export type ConversationStatsItem = z.infer<
  typeof peopleConversationStatsItemSchema
>;
export type ActorActivityDayReport = z.infer<
  typeof actorActivityDayReportSchema
>;
export type PeopleActivityDayReport = z.infer<
  typeof peopleActivityDayReportSchema
>;
export type ActorTotalsReport = z.infer<typeof actorTotalsReportSchema>;
export type ActorWindowMetrics = z.infer<typeof actorWindowMetricsSchema>;
export type ActorDirectoryWindows = z.infer<typeof actorDirectoryWindowsSchema>;
export type ActorSummaryReport = z.infer<typeof actorSummaryReportSchema>;
export type ActorDirectoryReport = z.infer<typeof actorDirectoryReportSchema>;
export type ActorProfileReport = z.infer<typeof actorProfileReportSchema>;
export type PersonalSpendReport = z.infer<typeof personalSpendReportSchema>;
export type PersonParams = z.infer<typeof personParamsSchema>;
