import * as z from "zod";

/** Mark one Conversation read or unread for the signed-in viewer. */
export const markConversationUnreadBodySchema = z
  .object({ unread: z.boolean() })
  .strict();

/** The viewer's read time after the change. */
export const markConversationUnreadResponseSchema = z
  .object({ readAt: z.string().datetime() })
  .strict();

export type MarkConversationUnreadBody = z.infer<
  typeof markConversationUnreadBodySchema
>;
export type MarkConversationUnreadResponse = z.infer<
  typeof markConversationUnreadResponseSchema
>;
