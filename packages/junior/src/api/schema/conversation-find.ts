import * as z from "zod";
import { conversationFeedItemSchema } from "./conversation-feed";

/** Most Conversations one find returns. */
export const MAX_CONVERSATION_FIND_MATCHES = 5;

/** A description of a Conversation that the viewer cannot name exactly. */
export const conversationFindBodySchema = z
  .object({ description: z.string().trim().min(3).max(500) })
  .strict();

/**
 * The viewer's Conversations that fit the description, best fit first. Each
 * has one short reason that says why it fits.
 */
export const conversationFindSchema = z
  .object({
    matches: z
      .array(
        z
          .object({
            conversation: conversationFeedItemSchema,
            reason: z.string().min(1),
          })
          .strict(),
      )
      .max(MAX_CONVERSATION_FIND_MATCHES),
  })
  .strict();

export type ConversationFindBody = z.infer<typeof conversationFindBodySchema>;
export type ConversationFind = z.infer<typeof conversationFindSchema>;
