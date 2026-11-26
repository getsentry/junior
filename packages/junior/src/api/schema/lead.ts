import * as z from "zod";

/**
 * The Lead of a Space. Members send it messages with the Conversation
 * message route.
 */
export const leadSchema = z
  .object({
    conversationId: z.string().min(1),
    /**
     * The Lead's newest event seq, read before its Watches, or -1 before its
     * first event. Watches change only in the Lead's Turns, so a transcript
     * event past this seq means the Watches may be out of date.
     */
    lastSeq: z.number().int().min(-1),
    /** The Conversations that the Lead has an active Watch on. */
    watchedConversationIds: z.array(z.string().min(1)),
  })
  .strict();
