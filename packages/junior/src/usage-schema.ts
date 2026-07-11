import { z } from "zod";

export const usageCostSchema = z
  .object({
    input: z.number().finite().nonnegative().optional(),
    output: z.number().finite().nonnegative().optional(),
    cacheRead: z.number().finite().nonnegative().optional(),
    cacheWrite: z.number().finite().nonnegative().optional(),
    total: z.number().finite().nonnegative().optional(),
  })
  .strict();

export const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    cacheCreationTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    cost: usageCostSchema.optional(),
  })
  .strict();

export type UsageCost = z.output<typeof usageCostSchema>;
export type Usage = z.output<typeof usageSchema>;
