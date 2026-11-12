import * as z from "zod";
import { throwApiError } from "../http";

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
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decode a `cursor` query value. The cursor only moves the position inside a
 * feed that membership already scopes, so it carries no signature.
 */
export function decodeConversationFeedCursor(
  value: string,
): ConversationFeedCursor {
  try {
    return conversationFeedCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch (error) {
    throwApiError(400, "Invalid conversation feed cursor.", error);
  }
}
