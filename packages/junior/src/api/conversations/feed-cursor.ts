import { and, eq, gt, lt, not, or, sql, type SQL } from "drizzle-orm";
import * as z from "zod";
import { throwApiError } from "../http";
import { juniorConversations } from "@/db/schema";

/**
 * Where a feed page ends, in the feed's order: pins first, then newest
 * activity, then id. It holds only a position; the next read applies the
 * same membership and visibility filters, so it grants nothing.
 */
const feedCursorSchema = z
  .object({
    conversationId: z.string().min(1),
    /** `last_activity_at` as Postgres prints it, so no precision is lost. */
    lastActivityAt: z.string().min(1),
    pinned: z.boolean(),
  })
  .strict();

export type FeedCursor = z.infer<typeof feedCursorSchema>;

/** Encode the position after the last row of a full feed page. */
export function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Decode a feed cursor from a request. A malformed cursor is a 400. */
export function decodeFeedCursor(value: string): FeedCursor {
  try {
    return feedCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throwApiError(400, "Invalid cursor.");
  }
}

/**
 * Keep the rows after `cursor` in feed order. `pinned` is the viewer's pin
 * expression when the feed sorts pins first; without it, pins do not sort.
 */
export function rowsAfterFeedCursor(
  cursor: FeedCursor,
  pinned: SQL | undefined,
): SQL {
  const at = sql`${cursor.lastActivityAt}::timestamptz`;
  const older = or(
    lt(juniorConversations.lastActivityAt, at),
    and(
      eq(juniorConversations.lastActivityAt, at),
      gt(juniorConversations.conversationId, cursor.conversationId),
    ),
  )!;
  if (!pinned) return older;
  // Unpinned rows all come after the last pinned row.
  return cursor.pinned
    ? or(not(pinned), and(pinned, older))!
    : and(not(pinned), older)!;
}
