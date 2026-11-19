import * as z from "zod";

/** The viewer's Lead. Messages to it use the Conversation message route. */
export const leadSchema = z
  .object({ conversationId: z.string().min(1) })
  .strict();
