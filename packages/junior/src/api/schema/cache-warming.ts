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
