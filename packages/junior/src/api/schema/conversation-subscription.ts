import * as z from "zod";

/** Subscribe to or unsubscribe from one Conversation for the viewer. */
export const conversationSubscriptionBodySchema = z
  .object({ subscribed: z.boolean().describe("False unsubscribes you.") })
  .strict();

/**
 * The viewer's subscription after the change. `archivedAt` is set when the
 * viewer was the last subscriber, so the unsubscribe archived the
 * Conversation for everyone.
 */
export const conversationSubscriptionResponseSchema = z
  .object({
    archivedAt: z
      .string()
      .datetime()
      .nullable()
      .describe("Set when the conversation is archived for everyone."),
    subscribed: z.boolean(),
  })
  .strict();

/** Invite one mentioned person, by Slack user id, to a public Conversation. */
export const conversationInviteBodySchema = z
  .object({ slackUserId: z.string().min(1).max(64) })
  .strict();

/** `added` is false when the person was already a Participant. */
export const conversationInviteResponseSchema = z
  .object({ added: z.boolean() })
  .strict();

export type ConversationInviteBody = z.infer<
  typeof conversationInviteBodySchema
>;
export type ConversationInviteResponse = z.infer<
  typeof conversationInviteResponseSchema
>;
export type ConversationSubscriptionBody = z.infer<
  typeof conversationSubscriptionBodySchema
>;
export type ConversationSubscriptionResponse = z.infer<
  typeof conversationSubscriptionResponseSchema
>;
