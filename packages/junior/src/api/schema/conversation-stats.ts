import * as z from "zod";

// Conversation stats report schemas. Conversation detail and event schemas
// live in `conversation.ts`.

export const conversationStatsItemSchema = z
  .object({
    active: z.number(),
    conversations: z.number(),
    durationMs: z.number(),
    failed: z.number(),
    label: z.string(),
    costUsd: z.number().optional(),
    tokens: z.number().optional(),
  })
  .strict();

/** UTC day (`YYYY-MM-DD`) or hour (`YYYY-MM-DDTHH`) activity bucket key. */
export const conversationMetricBucketSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2})?$/);

export const conversationMetricDaySchema = z
  .object({
    cachedInputTokens: z.number().optional(),
    cacheCreationTokens: z.number().optional(),
    conversations: z.number(),
    costUsd: z.number().optional(),
    date: conversationMetricBucketSchema,
    durationMs: z.number(),
    inputTokens: z.number().optional(),
    /** Conversation cost split to `mergedCodeChanges`. */
    mergedCodeChangeCostUsd: z.number().optional(),
    /** Code changes merged in this bucket. */
    mergedCodeChanges: z.number().optional(),
    tokens: z.number().optional(),
  })
  .strict();

/**
 * Model spend of one UTC day, split by the Turn Actor. `people` counts the
 * verified people with a Turn that day.
 */
export const personSpendDaySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Median spend of one active person. Absent on a day with no person. */
    medianPersonCostUsd: z.number().optional(),
    people: z.number(),
    personCostUsd: z.number(),
    /** Spend of Turns whose Actor is not a verified person. */
    unattributedCostUsd: z.number(),
  })
  .strict();

export const guardianMetricDaySchema = z
  .object({
    allow: z.number(),
    ask: z.number(),
    costUsd: z.number().optional(),
    date: conversationMetricBucketSchema,
    deny: z.number(),
    requests: z.number(),
  })
  .strict();

export const guardianStatsSchema = z
  .object({
    allow: z.number(),
    ask: z.number(),
    costUsd: z.number().optional(),
    deny: z.number(),
    metricDays: z.array(guardianMetricDaySchema),
    metricHours: z.array(guardianMetricDaySchema).optional(),
    metricSixHours: z.array(guardianMetricDaySchema).optional(),
    requests: z.number(),
  })
  .strict();

export const conversationStatsReportSchema = z
  .object({
    generatedAt: z.string(),
    guardian: guardianStatsSchema,
    metricDays: z.array(conversationMetricDaySchema),
    metricHours: z.array(conversationMetricDaySchema).optional(),
    metricSixHours: z.array(conversationMetricDaySchema).optional(),
    personSpendDays: z.array(personSpendDaySchema),
    source: z.literal("conversation_index"),
    windowEnd: z.string(),
    windowStart: z.string(),
  })
  .strict();

export type ConversationStatsItem = z.infer<typeof conversationStatsItemSchema>;
export type ConversationMetricDay = z.infer<typeof conversationMetricDaySchema>;
export type PersonSpendDay = z.infer<typeof personSpendDaySchema>;
export type GuardianMetricDay = z.infer<typeof guardianMetricDaySchema>;
export type GuardianStats = z.infer<typeof guardianStatsSchema>;
export type ConversationStatsReport = z.infer<
  typeof conversationStatsReportSchema
>;
