import * as z from "zod";

/**
 * How far the signed-in viewer has read a Conversation transcript.
 *
 * `lastReadSeq` is the event sequence of the last transcript row the viewer
 * saw. Reports only move it forward: the server keeps the highest value it
 * receives. Only Mark as unread moves it back. It is never before the
 * viewer's own latest Message.
 */
export const conversationReadPositionSchema = z
  .object({ lastReadSeq: z.number().int().nonnegative() })
  .strict();

export type ConversationReadPosition = z.infer<
  typeof conversationReadPositionSchema
>;

/**
 * The reply to a read report: the stored read position and whether Junior's
 * latest visible reply is still after it. The dashboard clears the unread
 * flag from this, so it does not refetch the feed after each report.
 */
export const conversationReadReportSchema = conversationReadPositionSchema
  .extend({ unreadReply: z.boolean() })
  .strict();

export type ConversationReadReport = z.infer<
  typeof conversationReadReportSchema
>;
