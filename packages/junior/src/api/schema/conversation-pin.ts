import * as z from "zod";

/** Pin or unpin one Conversation for the signed-in viewer. */
export const pinConversationBodySchema = z
  .object({ pinned: z.boolean() })
  .strict();

/** The viewer's pin time after the change, or null when unpinned. */
export const pinConversationResponseSchema = z
  .object({ pinnedAt: z.string().datetime().nullable() })
  .strict();

export type PinConversationBody = z.infer<typeof pinConversationBodySchema>;
export type PinConversationResponse = z.infer<
  typeof pinConversationResponseSchema
>;

/**
 * The viewer's full Pinned order, first to last. Each pin takes its index as
 * its new place.
 */
export const reorderPinnedConversationsBodySchema = z
  .object({
    conversationIds: z
      .array(z.string().min(1))
      .min(1)
      .max(500)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Each Conversation can appear once.",
      }),
  })
  .strict();

/** The pinned Conversations that got a new place, in order. */
export const reorderPinnedConversationsResponseSchema = z
  .object({ conversationIds: z.array(z.string()) })
  .strict();

export type ReorderPinnedConversationsBody = z.infer<
  typeof reorderPinnedConversationsBodySchema
>;
export type ReorderPinnedConversationsResponse = z.infer<
  typeof reorderPinnedConversationsResponseSchema
>;
