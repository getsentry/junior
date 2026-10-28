import { z } from "zod";
import { usageSchema } from "@/usage-schema";

/**
 * The part of a Conversation total that its child agents spent, at any depth.
 * Present only when the Conversation has child agents. The Conversation's own
 * part is the total minus this part.
 */
export const conversationChildAgentTotalsSchema = z
  .object({
    auxiliaryCostUsd: z.number().finite().nonnegative().optional(),
    count: z.number().int().positive(),
    cumulativeDurationMs: z.number(),
    cumulativeUsage: usageSchema.optional(),
  })
  .strict();

export type ConversationChildAgentTotals = z.infer<
  typeof conversationChildAgentTotalsSchema
>;
