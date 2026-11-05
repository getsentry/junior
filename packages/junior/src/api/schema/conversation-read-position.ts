import * as z from "zod";

/**
 * How far the signed-in viewer has read a Conversation transcript.
 *
 * `lastReadSeq` is the event sequence of the last transcript row the viewer
 * saw. The server keeps the highest value it receives, so it only moves
 * forward. It is never before the viewer's own latest Message.
 */
export const conversationReadPositionSchema = z
  .object({ lastReadSeq: z.number().int().nonnegative() })
  .strict();

export type ConversationReadPosition = z.infer<
  typeof conversationReadPositionSchema
>;
