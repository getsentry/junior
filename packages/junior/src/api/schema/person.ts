import * as z from "zod";
import { ownedObjectAnnotationSchema } from "@sentry/junior-plugin-api";
import {
  actorIdentitySchema,
  conversationSummaryReportSchema,
} from "./conversation";
import { codeChangeSummaryReportSchema } from "./code";
import { conversationStatsItemSchema } from "./conversation-stats";

export const personParamsSchema = z
  .object({ email: z.string().trim().min(1) })
  .strict();

/** Query of the people search that the composer `@` menu uses. */
export const peopleSearchQuerySchema = z
  .object({ q: z.string().trim().min(1).max(100) })
  .strict();

/** A person that a Message can mention: they have a Slack user id. */
export const mentionablePersonSchema = actorIdentitySchema
  .extend({ slackUserId: z.string().min(1) })
  .strict();

export const peopleSearchReportSchema = z
  .object({ people: z.array(mentionablePersonSchema) })
  .strict();

/** Route parameters for the photo of one Identity. */
export const avatarParamsSchema = z
  .object({ identityId: z.string().min(1).max(200) })
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

/**
 * One person in the People list. Counts and spend are per range; the Turn
 * range is all-time. Profile totals live on the profile read.
 */
export const actorSummaryReportSchema = z
  .object({
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
export type MentionablePerson = z.infer<typeof mentionablePersonSchema>;
export type PeopleSearchReport = z.infer<typeof peopleSearchReportSchema>;

/** The most recent merged code changes and Conversations a person card lists. */
export const PERSON_CARD_RECENT_LIMIT = 3;

/**
 * The person card that opens on a reference to a person: their object card,
 * when Junior knows them, the code changes they merged most recently, and
 * their recent Junior activity. The activity names only Conversations that
 * the viewer may read.
 */
export const personCardReportSchema = z
  .object({
    activity: z
      .object({
        /** The last Turn of the person in the last 30 days. */
        lastActiveAt: z.string().optional(),
        recentConversations: z
          .array(
            z
              .object({
                conversationId: z.string(),
                lastTurnAt: z.string(),
                title: z.string(),
              })
              .strict(),
          )
          .max(PERSON_CARD_RECENT_LIMIT),
      })
      .strict(),
    card: ownedObjectAnnotationSchema.optional(),
    /** The same code changes as the People profile, newest merge first. */
    mergedChanges: z
      .array(codeChangeSummaryReportSchema)
      .max(PERSON_CARD_RECENT_LIMIT),
  })
  .strict();

export type PersonCardReport = z.output<typeof personCardReportSchema>;
