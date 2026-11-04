import { z } from "zod";

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
