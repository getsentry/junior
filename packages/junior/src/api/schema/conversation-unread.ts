import * as z from "zod";

/**
 * Mark one Conversation read or unread for the signed-in viewer. The
 * response is the viewer's read position after the change.
 */
export const markConversationUnreadBodySchema = z
  .object({ unread: z.boolean() })
  .strict();

export type MarkConversationUnreadBody = z.infer<
  typeof markConversationUnreadBodySchema
>;
