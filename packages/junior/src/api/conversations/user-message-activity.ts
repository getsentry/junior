import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents } from "@/db/schema";

/** Read the latest true user message time for each selected conversation. */
export async function readLastUserMessageAtByConversation(
  db: JuniorDatabase,
  conversationIds: string[],
): Promise<Map<string, string>> {
  if (conversationIds.length === 0) return new Map();

  const authority = sql<string>`${juniorConversationEvents.payload}->'provenance'->>'authority'`;
  const actorPlatform = sql<string>`${juniorConversationEvents.payload}->'provenance'->'actor'->>'platform'`;
  const role = sql<string>`${juniorConversationEvents.payload}->>'role'`;
  const rows = await db
    .select({
      conversationId: juniorConversationEvents.conversationId,
      lastUserMessageAt: sql<Date>`max(${juniorConversationEvents.createdAt})`,
    })
    .from(juniorConversationEvents)
    .where(
      and(
        inArray(juniorConversationEvents.conversationId, conversationIds),
        or(
          and(
            eq(juniorConversationEvents.type, "user_message"),
            eq(authority, "instruction"),
            sql`${actorPlatform} in ('slack', 'local', 'web')`,
          ),
          and(
            eq(juniorConversationEvents.type, "message"),
            eq(role, "user"),
            isNotNull(juniorConversationEvents.actorIdentityId),
          ),
        ),
      ),
    )
    .groupBy(juniorConversationEvents.conversationId);

  return new Map(
    rows.map((row) => [
      row.conversationId,
      new Date(row.lastUserMessageAt).toISOString(),
    ]),
  );
}
