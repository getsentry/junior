import type { User } from "@sentry/junior-plugin-api";
import { and, count, eq, gt, max, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  juniorConversationEvents,
  juniorConversationReadPositions,
  juniorConversations,
  juniorIdentities,
} from "@/db/schema";
import { throwApiError } from "../http";
import type { ConversationReadPosition } from "../schema/conversation-read-position";
import { UNREAD_MESSAGE_COUNT_LIMIT } from "../schema/conversation";

/**
 * Read how far the viewer has read one Conversation, if they have read it.
 *
 * The viewer saw every Message up to one they wrote, also one sent from
 * Slack, so the position is at least their latest Message.
 */
export async function readConversationReadPosition(
  viewer: User,
  conversationId: string,
): Promise<ConversationReadPosition | undefined> {
  const [row] = await getDb()
    .select({
      lastReadSeq: sql<number>`greatest(${juniorConversationReadPositions.lastReadSeq}, (${latestViewerMessageSeq(viewer, conversationId)}))`,
    })
    .from(juniorConversationReadPositions)
    .where(
      and(
        eq(juniorConversationReadPositions.userId, viewer.id),
        eq(juniorConversationReadPositions.conversationId, conversationId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Count the Messages after a read position, up to the count limit. The
 * Conversation, type, and seq index covers the read, and the limit stops the
 * scan, so a reader far behind costs no more than one who is a little behind.
 */
export async function countUnreadMessages(
  conversationId: string,
  lastReadSeq: number,
): Promise<number> {
  const unread = getDb()
    .select({ seq: juniorConversationEvents.seq })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "message"),
        gt(juniorConversationEvents.seq, lastReadSeq),
      ),
    )
    .limit(UNREAD_MESSAGE_COUNT_LIMIT)
    .as("unread");
  const [row] = await getDb().select({ count: count() }).from(unread);
  return row?.count ?? 0;
}

/** The seq of the latest Message that one of the viewer's Identities wrote. */
function latestViewerMessageSeq(viewer: User, conversationId: string) {
  return getDb()
    .select({ seq: max(juniorConversationEvents.seq) })
    .from(juniorConversationEvents)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversationEvents.actorIdentityId),
    )
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "message"),
        eq(juniorIdentities.userId, viewer.id),
      ),
    );
}

/**
 * Move the viewer's read position forward.
 *
 * The stored value never goes back, so devices can report in any order. A
 * value past the last event is cut to the last event, so a bad client cannot
 * hide messages that arrive later.
 */
export async function markConversationRead(
  viewer: User,
  conversationId: string,
  body: ConversationReadPosition,
): Promise<ConversationReadPosition> {
  const db = getDb();
  const [conversation] = await db
    .select({ lastSeq: max(juniorConversationEvents.seq) })
    .from(juniorConversations)
    .leftJoin(
      juniorConversationEvents,
      eq(
        juniorConversationEvents.conversationId,
        juniorConversations.conversationId,
      ),
    )
    .where(eq(juniorConversations.conversationId, conversationId))
    .groupBy(juniorConversations.conversationId);
  if (!conversation) throwApiError(404, "Conversation not found.");

  await db
    .insert(juniorConversationReadPositions)
    .values({
      conversationId,
      lastReadSeq: Math.min(body.lastReadSeq, conversation.lastSeq ?? 0),
      updatedAt: new Date(),
      userId: viewer.id,
    })
    .onConflictDoUpdate({
      target: [
        juniorConversationReadPositions.userId,
        juniorConversationReadPositions.conversationId,
      ],
      set: {
        lastReadSeq: sql`greatest(${juniorConversationReadPositions.lastReadSeq}, excluded.last_read_seq)`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  // Return what detail reads, so the cached detail opens at the same place.
  return (await readConversationReadPosition(viewer, conversationId))!;
}
