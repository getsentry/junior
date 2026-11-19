import * as z from "zod";

export const cacheWarmingBreakerSchema = z
  .object({
    provider: z.string(),
    open: z.boolean(),
    lastOpenedAt: z.string().datetime().optional(),
    /** When an admin closed it, or when its pause ended. */
    lastClosedAt: z.string().datetime().optional(),
  })
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

const HOUR_MS = 60 * 60 * 1_000;
/** Longest hourly window. Hourly counters are kept for 15 days. */
export const CACHE_WARMING_HOURLY_MAX_HOURS = 14 * 24;

/**
 * An hourly window. `end` defaults to now and `start` to 24 hours before
 * `end`. Both round to whole UTC hours: `start` down, `end` up, so the
 * current hour counts.
 */
export const cacheWarmingHourlyQuerySchema = z
  .object({
    start: z.string().datetime({ offset: true }).optional(),
    end: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .transform((query, context) => {
    const endMs =
      Math.ceil((query.end ? Date.parse(query.end) : Date.now()) / HOUR_MS) *
      HOUR_MS;
    const startMs =
      Math.floor(
        (query.start ? Date.parse(query.start) : endMs - 24 * HOUR_MS) /
          HOUR_MS,
      ) * HOUR_MS;
    const hours = (endMs - startMs) / HOUR_MS;
    if (hours < 1 || hours > CACHE_WARMING_HOURLY_MAX_HOURS) {
      context.addIssue({
        code: "custom",
        message: `The window must span 1 to ${CACHE_WARMING_HOURLY_MAX_HOURS} hours.`,
      });
      return z.NEVER;
    }
    return { startMs, endMs };
  });

const hourlySavingsSchema = cacheWarmingSavingsSchema.extend({
  netSavingsUsd: z.number(),
  /** Net savings over oracle savings. Null with no oracle savings. */
  effectiveness: z.number().nullable(),
});

/**
 * Prompt cache of agent model calls, not warmups. A full rewrite wrote over
 * 50k cache tokens and read under 20k.
 */
const modelCacheSchema = z
  .object({
    calls: z.number().int().nonnegative(),
    fullRewrites: z.number().int().nonnegative(),
    /** Every input token, cached or not. */
    inputTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    /** Cache write tokens over input tokens. Null with no input. */
    writeShare: z.number().nullable(),
    /** Full rewrites over calls. Null with no calls. */
    fullRewriteRate: z.number().nullable(),
  })
  .strict();

const warmupOutcomesSchema = z
  .object({
    /** Warmup calls that the provider answered, idle and tool wait. */
    sent: z.number().int().nonnegative(),
    /** Sent warmups that did not read the cached prefix. */
    missed: z.number().int().nonnegative(),
    /** Warmed idle periods whose return still wrote the cache. */
    warmedRewrites: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .strict();

const countsSchema = z.record(z.string(), z.number().int().nonnegative());

export const cacheWarmingHourlyReportSchema = z
  .object({
    start: z.string().datetime(),
    end: z.string().datetime(),
    hours: z.array(
      z
        .object({
          hour: z.string().datetime(),
          savings: hourlySavingsSchema,
          modelCache: modelCacheSchema,
          warmups: warmupOutcomesSchema,
        })
        .strict(),
    ),
    totals: z
      .object({
        savings: hourlySavingsSchema,
        modelCache: modelCacheSchema,
        modelCacheByModel: z.array(
          modelCacheSchema.extend({ model: z.string() }),
        ),
        warmups: warmupOutcomesSchema.extend({
          /** By how the Turn before the idle period ended, or `tool_wait`. */
          sentByTurnEnding: countsSchema,
          /** By `app.cache_warming.skip_reason`. */
          skipReasons: countsSchema,
        }),
        breakerOpened: z.number().int().nonnegative(),
        breakerClosed: z.number().int().nonnegative(),
      })
      .strict(),
    /** The same window a week earlier. */
    lastWeek: z
      .object({
        start: z.string().datetime(),
        end: z.string().datetime(),
        modelCache: modelCacheSchema,
      })
      .strict(),
    breakers: z.array(cacheWarmingBreakerSchema),
  })
  .strict();

export type CacheWarmingHourlyReport = z.output<
  typeof cacheWarmingHourlyReportSchema
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
