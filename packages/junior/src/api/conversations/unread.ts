import type { User } from "@sentry/junior-plugin-api";
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { getDb, getSqlExecutor } from "@/chat/db";
import { resolveRootConversationId } from "@/chat/conversations/sql/participants";
import {
  juniorConversationEvents,
  juniorConversationReadPositions,
  juniorConversations,
  juniorIdentities,
} from "@/db/schema";
import { throwApiError } from "../http";
import type {
  ConversationReadPosition,
  ConversationReadReport,
} from "../schema/conversation-read-position";
import type {
  ConversationUnread,
  MarkConversationUnreadBody,
} from "../schema/conversation-unread";
import { readConversationAccessFromSql } from "./access";
import { markConversationRead } from "./read-position";

/**
 * Junior's newest reply in the outer Conversation that the transcript shows
 * as its own row. Quiet replies fold into activity, like tools and status
 * events, so they do not count. It walks the message role index from the
 * newest Message, so it stops at the first reply that is not quiet.
 */
function latestVisibleReply(db: JuniorDatabase) {
  return db
    .select({ seq: juniorConversationEvents.seq })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(
          juniorConversationEvents.conversationId,
          juniorConversations.conversationId,
        ),
        eq(juniorConversationEvents.type, "message"),
        sql`${juniorConversationEvents.payload}->>'role' = 'assistant'`,
        sql`(${juniorConversationEvents.payload}->'meta'->>'quiet') is distinct from 'true'`,
      ),
    )
    .orderBy(
      desc(juniorConversationEvents.createdAt),
      desc(juniorConversationEvents.seq),
    )
    .limit(1)
    .as("latest_visible_reply");
}

/** The seq of the user's latest Message in the outer Conversation. */
function viewerMessageSeq(db: JuniorDatabase, userId: string) {
  return db
    .select({ seq: max(juniorConversationEvents.seq) })
    .from(juniorConversationEvents)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversationEvents.actorIdentityId),
    )
    .where(
      and(
        eq(
          juniorConversationEvents.conversationId,
          juniorConversations.conversationId,
        ),
        eq(juniorConversationEvents.type, "message"),
        eq(juniorIdentities.userId, userId),
      ),
    );
}

/**
 * Return the Conversations that have a visible Junior reply after the
 * user's read position. The position is at least the user's own latest
 * Message, so a reply in Slack or the dashboard counts as read.
 *
 * A Conversation with no stored read position counts from its start. The
 * read-position backfill migration gave each root in a user's feed a
 * position at its last event, so only Conversations that start after it
 * have none.
 */
export async function readUnreadConversationIds(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  userId: string,
): Promise<Set<string>> {
  if (conversationIds.length === 0) return new Set();
  const reply = latestVisibleReply(db);
  const rows = await db
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .leftJoin(
      juniorConversationReadPositions,
      and(
        eq(
          juniorConversationReadPositions.conversationId,
          juniorConversations.conversationId,
        ),
        eq(juniorConversationReadPositions.userId, userId),
      ),
    )
    .innerJoinLateral(reply, sql`true`)
    .where(
      and(
        inArray(juniorConversations.conversationId, [...conversationIds]),
        sql`${reply.seq} > greatest(coalesce(${juniorConversationReadPositions.lastReadSeq}, -1), coalesce((${viewerMessageSeq(db, userId)}), -1))`,
      ),
    );
  return new Set(rows.map((row) => row.conversationId));
}

/**
 * Store a read report and say whether Junior's latest visible reply is still
 * unread, so the dashboard can clear its unread flag without a refetch.
 */
export async function reportConversationRead(
  viewer: User,
  conversationId: string,
  body: ConversationReadPosition,
): Promise<ConversationReadReport> {
  const readPosition = await markConversationRead(viewer, conversationId, body);
  const unread = await readUnreadConversationIds(
    getDb(),
    [conversationId],
    viewer.id,
  );
  return { ...readPosition, unreadReply: unread.has(conversationId) };
}

/**
 * Mark one Conversation read or unread for the signed-in viewer. Both write
 * the read position of the root, which the feed reads.
 *
 * Read moves the position to the last event. Unread is the one write that
 * moves it back: to just before Junior's latest visible reply, so the
 * transcript shows that reply as new again. A reply at seq 0 has no seq
 * before it, so unread removes the position and the Conversation counts from
 * its start. The viewer's own latest Message also counts as read, so unread
 * fails when that Message is after the reply.
 */
export async function markConversationUnread(
  viewer: User,
  conversationId: string,
  body: MarkConversationUnreadBody,
): Promise<ConversationUnread> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  const rootConversationId = await resolveRootConversationId(
    getSqlExecutor(),
    conversationId,
  );
  if (!body.unread) {
    // The store cuts a value past the last event to the last event.
    await markConversationRead(viewer, rootConversationId, {
      lastReadSeq: Number.MAX_SAFE_INTEGER,
    });
    return { unreadReply: false };
  }
  const db = getDb();
  const reply = latestVisibleReply(db);
  const [row] = await db
    .select({
      replySeq: reply.seq,
      viewerSeq: sql<number | null>`(${viewerMessageSeq(db, viewer.id)})`,
    })
    .from(juniorConversations)
    .innerJoinLateral(reply, sql`true`)
    .where(eq(juniorConversations.conversationId, rootConversationId));
  if (!row || (row.viewerSeq !== null && row.viewerSeq >= row.replySeq)) {
    throwApiError(409, "Conversation has no reply after your last message.");
  }
  if (row.replySeq === 0) {
    await db
      .delete(juniorConversationReadPositions)
      .where(
        and(
          eq(juniorConversationReadPositions.userId, viewer.id),
          eq(
            juniorConversationReadPositions.conversationId,
            rootConversationId,
          ),
        ),
      );
    return { unreadReply: true };
  }
  await db
    .insert(juniorConversationReadPositions)
    .values({
      conversationId: rootConversationId,
      lastReadSeq: row.replySeq - 1,
      updatedAt: new Date(),
      userId: viewer.id,
    })
    .onConflictDoUpdate({
      target: [
        juniorConversationReadPositions.userId,
        juniorConversationReadPositions.conversationId,
      ],
      set: {
        lastReadSeq: sql`excluded.last_read_seq`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  return { unreadReply: true };
}
