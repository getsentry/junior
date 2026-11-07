import * as z from "zod";

export const versionsQuerySchema = z
  .object({
    /** The open Conversation, whose token comes back as `conversation`. */
    conversationId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Opaque change tokens for the dashboard reads that refresh by themselves.
 * A token changes when the read it covers can change. Compare a token only
 * with an earlier token of the same field.
 */
export const versionsSchema = z
  .object({
    /**
     * Tree token of the requested Conversation, the same value as the
     * detail report's `CONVERSATION_VERSION_HEADER`. Missing when it does
     * not exist.
     */
    conversation: z.string().min(1).optional(),
    /** The viewer's Conversation feed. */
    conversations: z.string().min(1),
    /** Open Review items that need the viewer. */
    reviewItems: z.string().min(1),
    /** The viewer's rolling model spend. */
    spend: z.string().min(1),
  })
  .strict();

export type Versions = z.output<typeof versionsSchema>;
