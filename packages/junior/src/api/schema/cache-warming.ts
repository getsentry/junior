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
    netSavingsUsd: z.number(),
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
    days: z.array(cacheWarmingSavingsSchema.extend({ date: z.string() })),
    totals: cacheWarmingSavingsSchema.extend({
      /** Net savings over oracle savings. Null with no oracle savings. */
      effectiveness: z.number().nullable(),
    }),
  })
  .strict();

export type CacheWarmingSavingsReport = z.output<
  typeof cacheWarmingSavingsReportSchema
>;
