import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorIdentities,
} from "@/db/schema";
import { isUserInstruction } from "@/db/schema/conversation-events";

/**
 * The newest event of one type in the outer Conversation that matches the
 * filter. It walks the message role or user message time index from the
 * newest event. The user message index has only matching entries, so that
 * read stops at the first one.
 */
function latestEventAt(
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
    .limit(1)
    .as(`latest_${type}`);
}

/** Read the latest true user message time for each selected conversation. */
export async function readLastUserMessageAtByConversation(
  db: JuniorDatabase,
  conversationIds: string[],
): Promise<Map<string, string>> {
  if (conversationIds.length === 0) return new Map();

  const payload = juniorConversationEvents.payload;
  const instruction = latestEventAt(
    db,
    "user_message",
    isUserInstruction(payload),
  );
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
  const message = latestEventAt(
    db,
    "message",
    sql`${payload}->>'role' = 'user' and ${authorKind} = 'user'`,
  );
  const rows = await db
    .select({
      conversationId: juniorConversations.conversationId,
      instructionAt: instruction.createdAt,
      messageAt: message.createdAt,
    })
    .from(juniorConversations)
    .leftJoinLateral(instruction, sql`true`)
    .leftJoinLateral(message, sql`true`)
    .where(inArray(juniorConversations.conversationId, conversationIds));

  const result = new Map<string, string>();
  for (const { conversationId, instructionAt, messageAt } of rows) {
    const times = [instructionAt, messageAt].flatMap((at) =>
      at ? [at.getTime()] : [],
    );
    if (times.length > 0) {
      result.set(conversationId, new Date(Math.max(...times)).toISOString());
    }
  }
  return result;
}
