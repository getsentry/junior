import { and, asc, eq, like, sql } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { juniorConversationEvents } from "@/db/schema";

/** Prefix of the author id of every parent message. */
export const PARENT_MESSAGE_AUTHOR_PREFIX = "parent-agent:";

/**
 * Read the author Identity ids of the saved parent messages of one child,
 * oldest first: the Actors of the parent's Turns that gave the child work.
 * A Message saved before parent messages had a person author gives the
 * system Identity.
 */
export async function readParentMessageAuthorIdentityIds(
  conversationId: string,
): Promise<string[]> {
  const payload = juniorConversationEvents.payload;
  const rows = await getSqlExecutor()
    .db()
    .select({ identityId: juniorConversationEvents.actorIdentityId })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "message"),
        like(
          sql`${payload}->'meta'->'author'->>'userId'`,
          `${PARENT_MESSAGE_AUTHOR_PREFIX}%`,
        ),
      ),
    )
    .orderBy(asc(juniorConversationEvents.seq));
  return rows.flatMap((row) => (row.identityId ? [row.identityId] : []));
}
