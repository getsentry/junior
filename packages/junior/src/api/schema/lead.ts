import * as z from "zod";

/**
 * The Lead of a Space. Members send it messages with the Conversation
 * message route.
 */
export const leadSchema = z
  .object({ conversationId: z.string().min(1) })
  .strict();
