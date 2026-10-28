import { z } from "zod";

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
    tokens: z.number().optional(),
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
    active: z.number(),
    cachedInputTokens: z.number().optional(),
    cacheCreationTokens: z.number().optional(),
    conversations: z.number(),
    durationMs: z.number(),
    failed: z.number(),
    generatedAt: z.string(),
    guardian: guardianStatsSchema,
    metricDays: z.array(conversationMetricDaySchema),
    metricHours: z.array(conversationMetricDaySchema).optional(),
    metricSixHours: z.array(conversationMetricDaySchema).optional(),
    locations: z.array(conversationStatsItemSchema),
    actors: z.array(conversationStatsItemSchema),
    source: z.literal("conversation_index"),
    costUsd: z.number().optional(),
    inputTokens: z.number().optional(),
    tokens: z.number().optional(),
    windowEnd: z.string(),
    windowStart: z.string(),
  })
  .strict();

export type ConversationStatsItem = z.infer<typeof conversationStatsItemSchema>;
export type ConversationMetricDay = z.infer<typeof conversationMetricDaySchema>;
export type GuardianMetricDay = z.infer<typeof guardianMetricDaySchema>;
export type GuardianStats = z.infer<typeof guardianStatsSchema>;
export type ConversationStatsReport = z.infer<
  typeof conversationStatsReportSchema
>;
