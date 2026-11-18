import * as z from "zod";
import { decodePageCursor, encodePageCursor } from "../page-cursor";

/**
 * Position after the last row of one feed page. `at` keeps the microseconds
 * that Postgres stores: a cursor cut to milliseconds would skip rows that
 * share the millisecond.
 */
const conversationFeedCursorSchema = z
  .object({
    at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    conversationId: z.string().min(1),
  })
  .strict();

export type ConversationFeedCursor = z.infer<
  typeof conversationFeedCursorSchema
>;

/** Encode the feed position after one row for `nextCursor`. */
export function encodeConversationFeedCursor(
  cursor: ConversationFeedCursor,
): string {
  return encodePageCursor(conversationFeedCursorSchema, cursor);
}

/** Decode a feed `cursor` query value. */
export function decodeConversationFeedCursor(
  value: string,
): ConversationFeedCursor {
  return decodePageCursor(
    conversationFeedCursorSchema,
    value,
    "Invalid conversation feed cursor.",
  );
}
