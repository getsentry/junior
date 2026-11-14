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
        /**
         * Saved less warmup cost. Null on a day filled from history, which
         * has no warmup calls, so its warmup cost is unknown.
         */
        netSavingsUsd: z.number().nullable(),
      }),
    ),
    totals: cacheWarmingSavingsSchema.extend({
      /** Net savings of the days with known warmup cost. */
      netSavingsUsd: z.number(),
      /** Oracle savings of the days with known warmup cost. */
      knownCostOracleSavingsUsd: z.number().nonnegative(),
      /**
       * Net savings over oracle savings of the days with known warmup cost.
       * Null with no oracle savings on those days.
       */
      effectiveness: z.number().nullable(),
      /** Days filled from history, with unknown warmup cost. */
      unknownCostDays: z.number().int().nonnegative(),
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
