import type { User } from "@sentry/junior-plugin-api";
import { and, eq, max, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  juniorConversationEvents,
  juniorConversationReadPositions,
  juniorConversations,
} from "@/db/schema";
import { throwApiError } from "../http";
import type { ConversationReadPosition } from "../schema/conversation-read-position";

/** Read how far the viewer has read one Conversation, if they have read it. */
export async function readConversationReadPosition(
  viewer: User,
  conversationId: string,
): Promise<ConversationReadPosition | undefined> {
  const [row] = await getDb()
    .select({ lastReadSeq: juniorConversationReadPositions.lastReadSeq })
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

  const [row] = await db
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
    })
    .returning({ lastReadSeq: juniorConversationReadPositions.lastReadSeq });
  return row!;
}
