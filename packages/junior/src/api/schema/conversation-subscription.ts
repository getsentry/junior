import * as z from "zod";

/** Subscribe to or unsubscribe from one Conversation for the viewer. */
export const conversationSubscriptionBodySchema = z
  .object({ subscribed: z.boolean() })
  .strict();

/**
 * The viewer's subscription after the change. `archivedAt` is set when the
 * viewer was the last subscriber, so the unsubscribe archived the
 * Conversation for everyone.
 */
export const conversationSubscriptionResponseSchema = z
  .object({
    archivedAt: z.string().datetime().nullable(),
    subscribed: z.boolean(),
  })
  .strict();

export type ConversationSubscriptionBody = z.infer<
  typeof conversationSubscriptionBodySchema
>;
export type ConversationSubscriptionResponse = z.infer<
  typeof conversationSubscriptionResponseSchema
>;
