import { z } from "zod";

/**
 * The unread rows to summarize: every event after `afterSeq`, through
 * `throughSeq`. The dashboard sends the range from when the Conversation
 * opened, so rows that arrive later do not change the summary.
 */
export const conversationCatchUpBodySchema = z
  .object({
    afterSeq: z.number().int().nonnegative(),
    throughSeq: z.number().int().nonnegative(),
  })
  .strict()
  .refine((range) => range.throughSeq > range.afterSeq, {
    message: "throughSeq must be after afterSeq.",
  });

/** A short summary of the unread rows, and what waits on the reader. */
export const conversationCatchUpSchema = z
  .object({
    needsYou: z.string().min(1).optional(),
    summary: z.string().min(1),
  })
  .strict();

export type ConversationCatchUpBody = z.infer<
  typeof conversationCatchUpBodySchema
>;
export type ConversationCatchUp = z.infer<typeof conversationCatchUpSchema>;
