import * as z from "zod";

/** The viewer's Lead. Messages to it use the Conversation message route. */
export const leadSchema = z
  .object({
    conversationId: z.string().min(1),
    /** The Conversations that the Lead has an active Watch on. */
    watchedConversationIds: z.array(z.string().min(1)),
  })
  .strict();
