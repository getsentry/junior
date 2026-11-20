import * as z from "zod";

export const cacheWarmingBreakerSchema = z
  .object({ provider: z.string(), open: z.boolean() })
  .strict();

export const cacheWarmingBreakerListSchema = z
  .object({ breakers: z.array(cacheWarmingBreakerSchema) })
  .strict();

export const cacheWarmingBreakerParamsSchema = z
  .object({
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(64),
  })
  .strict();

export const closeCacheWarmingBreakerResponseSchema = z
  .object({ closed: z.literal(true) })
  .strict();

export const cacheWarmingSavingsQuerySchema = z
  .object({
    /** Trailing UTC days, today included. */
    days: z
      .enum(["1", "7", "30", "90"])
      .default("30")
      .transform((days) => Number(days)),
  })
  .strict();

/** What cache warming saved, in dollars. Net savings can be negative. */
const cacheWarmingSavingsSchema = z
  .object({
    /** Idle periods that count, as defined by `idlePeriodSavings`. */
    idlePeriods: z.number().int().nonnegative(),
    /** Idle periods whose next call read the warmed cache. */
    hits: z.number().int().nonnegative(),
    /** Cache writes that the hits avoided, less their cache reads. */
    savedUsd: z.number().nonnegative(),
    /** Cost of every idle warmup call. */
    warmupCostUsd: z.number().nonnegative(),
    /** Savings of an ideal warmer that knew each gap. */
    oracleSavingsUsd: z.number().nonnegative(),
    /** Idle periods with no warm state, such as a too large snapshot. */
    unwarmedIdlePeriods: z.number().int().nonnegative(),
    /** The part of the oracle savings from idle periods with no warm state. */
    unwarmedOracleSavingsUsd: z.number().nonnegative(),
  })
  .strict();

export const cacheWarmingSavingsReportSchema = z
  .object({
    days: z.array(
      cacheWarmingSavingsSchema.extend({
        date: z.string(),
        /** Saved less warmup cost. */
        netSavingsUsd: z.number(),
        /**
         * Filled from history: hits count only when a recorded warmup call
         * reached the return, and the warm state split is unknown.
         */
        history: z.boolean(),
      }),
    ),
    totals: cacheWarmingSavingsSchema.extend({
      netSavingsUsd: z.number(),
      /** Oracle savings of the days with live counters. */
      liveOracleSavingsUsd: z.number().nonnegative(),
      /** Net savings over oracle savings. Null with no oracle savings. */
      effectiveness: z.number().nullable(),
      /** Days filled from history. The totals include them. */
      historyDays: z.number().int().nonnegative(),
    }),
  })
  .strict();

export type CacheWarmingSavingsReport = z.output<
  typeof cacheWarmingSavingsReportSchema
>;

export const cacheWarmingSavingsRefillSchema = z
  .object({
    status: z.enum(["idle", "pending", "running", "done", "failed"]),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    error: z.string().optional(),
    scannedConversations: z.number().int().nonnegative().optional(),
    totalConversations: z.number().int().nonnegative().optional(),
  })
  .strict();

export const cacheWarmingSavingsRefillResponseSchema = z
  .object({ refill: cacheWarmingSavingsRefillSchema })
  .strict();

export type CacheWarmingSavingsRefill = z.output<
  typeof cacheWarmingSavingsRefillSchema
>;

export const cacheHealthQuerySchema = z
  .object({ window: z.enum(["24h", "7d"]).default("24h") })
  .strict();

/** Prompt cache of agent model calls, without warmups. */
const cacheHealthCallsSchema = z
  .object({
    calls: z.number().int().nonnegative(),
    /** Input tokens, cache reads and writes included. */
    inputTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Cache health of a recent window, read from Junior's own Sentry telemetry.
 * A full rewrite wrote over 50k tokens to the cache and read under 20k.
 */
const cacheHealthDataSchema = z
  .object({
    status: z.literal("ok"),
    window: z.enum(["24h", "7d"]),
    /** The agent model whose calls count. */
    modelId: z.string(),
    /** When Sentry answered. */
    fetchedAt: z.string(),
    /** Sentry rate limited a newer read, so this is an older answer. */
    stale: z.boolean(),
    buckets: z.array(
      cacheHealthCallsSchema.extend({
        /** UTC bucket start, `YYYY-MM-DDTHH`. */
        start: z.string(),
        fullRewrites: z.number().int().nonnegative(),
      }),
    ),
    /** The same window a week earlier. */
    lastWeek: cacheHealthCallsSchema,
    warmups: z
      .object({
        /** Warmup calls by how the Turn before ended, or `tool_wait`. */
        sentByTurnEnding: z.record(z.string(), z.number().int().nonnegative()),
        skipReasons: z.record(z.string(), z.number().int().nonnegative()),
        /** Cost of every warmup call. */
        costUsd: z.number().nonnegative(),
      })
      .strict(),
    /** Idle periods that count, by `IdlePeriodOutcome`. */
    idlePeriods: z
      .object({
        saved: z.number().int().nonnegative(),
        notWarmed: z.number().int().nonnegative(),
        stoppedEarly: z.number().int().nonnegative(),
        cacheLost: z.number().int().nonnegative(),
        /** Cache writes that the saved periods avoided, less their reads. */
        savedUsd: z.number().nonnegative(),
      })
      .strict(),
    breakers: z.array(cacheWarmingBreakerSchema),
    /** Breaker changes in the window. A close at the end of a pause is not one. */
    breakerEvents: z
      .object({
        opened: z.number().int().nonnegative(),
        closed: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const cacheHealthReportSchema = z.discriminatedUnion("status", [
  cacheHealthDataSchema,
  /** Junior cannot read its telemetry until these settings are set. */
  z
    .object({
      status: z.literal("unconfigured"),
      missing: z.array(
        z.enum(["SENTRY_DSN", "SENTRY_ORG_SLUG", "SENTRY_READ_TOKEN"]),
      ),
    })
    .strict(),
  /** Sentry rejected the token. */
  z.object({ status: z.literal("denied") }).strict(),
  /** Sentry rate limited the read, and no earlier answer is stored. */
  z.object({ status: z.literal("rate_limited") }).strict(),
]);

export type CacheHealthReport = z.output<typeof cacheHealthReportSchema>;
