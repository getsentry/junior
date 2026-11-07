import * as z from "zod";

/** Mark one Conversation read or unread for the signed-in viewer. */
export const markConversationUnreadBodySchema = z
  .object({ unread: z.boolean() })
  .strict();

export type MarkConversationUnreadBody = z.infer<
  typeof markConversationUnreadBodySchema
>;

/**
 * Whether Junior's latest visible reply is after the viewer's read position
 * once the change is stored.
 */
export const conversationUnreadSchema = z
  .object({ unreadReply: z.boolean() })
  .strict();

export type ConversationUnread = z.infer<typeof conversationUnreadSchema>;
