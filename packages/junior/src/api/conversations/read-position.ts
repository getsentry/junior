import type { User } from "@sentry/junior-plugin-api";
import { and, eq, max, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  juniorConversationEvents,
  juniorConversationReadPositions,
  juniorConversations,
  juniorIdentities,
} from "@/db/schema";
import { throwApiError } from "../http";
import type { ConversationReadPosition } from "../schema/conversation-read-position";

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
