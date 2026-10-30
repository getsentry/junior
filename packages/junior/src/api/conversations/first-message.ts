import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents } from "@/db/schema";

/**
 * Read the text of the first human message for each untitled conversation.
 * Read-time titles use it while the generated title is still unset.
 */
export async function readFirstHumanMessageTexts(
  db: JuniorDatabase,
  conversations: ReadonlyArray<{
    conversationId: string;
    title?: string | null;
  }>,
): Promise<Map<string, string>> {
  const untitledIds = conversations.flatMap((conversation) =>
    conversation.title ? [] : [conversation.conversationId],
  );
  if (untitledIds.length === 0) return new Map();

  const text = sql<string>`${juniorConversationEvents.payload}->>'text'`;
  const rows = await db
    .selectDistinctOn([juniorConversationEvents.conversationId], {
      conversationId: juniorConversationEvents.conversationId,
      text: text.as("text"),
    })
    .from(juniorConversationEvents)
    .where(
      and(
        inArray(juniorConversationEvents.conversationId, untitledIds),
        eq(juniorConversationEvents.type, "message"),
        sql`${juniorConversationEvents.payload}->>'role' = 'user'`,
        sql`coalesce(${juniorConversationEvents.payload}->'meta'->'author'->>'isBot', 'false') <> 'true'`,
        isNotNull(sql`nullif(btrim(${text}), '')`),
      ),
    )
    .orderBy(
      juniorConversationEvents.conversationId,
      asc(juniorConversationEvents.createdAt),
      asc(juniorConversationEvents.seq),
    );

  return new Map(rows.map((row) => [row.conversationId, row.text]));
}
