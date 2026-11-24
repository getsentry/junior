import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { JuniorDatabase, JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorIdentities,
} from "@/db/schema";
import { isUserInstruction } from "@/db/schema/conversation-events";

/**
 * Return a query for the newest event of one type in the outer Conversation
 * that matches the filter. It walks the message role or user message time
 * index from the newest event. The user message index has only matching
 * entries, so that read stops at the first one.
 */
function latestEventAtQuery(
  db: JuniorDatabase,
  type: "message" | "user_message",
  filter: SQL,
) {
  return db
    .select({ createdAt: juniorConversationEvents.createdAt })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(
          juniorConversationEvents.conversationId,
          juniorConversations.conversationId,
        ),
        eq(juniorConversationEvents.type, type),
        filter,
      ),
    )
    .orderBy(
      desc(juniorConversationEvents.createdAt),
      desc(juniorConversationEvents.seq),
    )
    .limit(1);
}

/**
 * Return queries for the latest user instruction and the latest true user
 * Message of the outer Conversation.
 */
export function userMessageQueries(db: JuniorDatabase) {
  const payload = juniorConversationEvents.payload;
  // System Messages, such as events, carry the system Identity. A scalar
  // subquery, unlike a join or `exists`, keeps the newest-first index walk:
  // it reads entries only until the first Message from a user. An index
  // predicate cannot hold this check, because it reads another table.
  const authorKind = sql`(${db
    .select({ kind: juniorIdentities.kind })
    .from(juniorIdentities)
    .where(
      eq(juniorIdentities.id, juniorConversationEvents.actorIdentityId),
    )})`;
  return {
    instruction: latestEventAtQuery(
      db,
      "user_message",
      isUserInstruction(payload),
    ),
    message: latestEventAtQuery(
      db,
      "message",
      sql`${payload}->>'role' = 'user' and ${authorKind} = 'user'`,
    ),
  };
}

/**
 * Return SQL for when the outer Conversation last got a Message that a
 * reader would notice: a true user message or a Junior reply that the
 * transcript shows. Tools, status, Events, quiet replies, and progress acks
 * (`meta.progress`) do not count. It is null when there is no such Message.
 */
export function lastMessageAtSql(db: JuniorDatabase): SQL<Date | null> {
  const payload = juniorConversationEvents.payload;
  const { instruction, message } = userMessageQueries(db);
  const reply = latestEventAtQuery(
    db,
    "message",
    sql`${payload}->>'role' = 'assistant' and (${payload}->'meta'->>'quiet') is distinct from 'true' and (${payload}->'meta'->>'progress') is distinct from 'true'`,
  );
  // `greatest` skips nulls.
  return sql<Date | null>`greatest((${instruction}), (${message}), (${reply}))`.mapWith(
    juniorConversations.lastMessageAt,
  );
}

/**
 * Store `lastMessageAtSql` on the Conversation row. Event appends call this
 * in their transaction when they add a Message, so feed reads take the time
 * from the row.
 */
export async function refreshLastMessageAt(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<void> {
  const db = executor.db();
  // oxlint-disable-next-line junior/touch-conversation-detail -- the caller bumps in the same transaction.
  await db
    .update(juniorConversations)
    .set({ lastMessageAt: lastMessageAtSql(db) })
    .where(eq(juniorConversations.conversationId, conversationId));
}
