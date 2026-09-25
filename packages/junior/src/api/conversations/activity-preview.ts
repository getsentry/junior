import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents } from "@/db/schema";
import type { ConversationActivityPreview } from "../schema/conversation";

/** Read one recent assistant message, or the latest user message, for each conversation. */
export async function readConversationActivityPreviews(
  db: JuniorDatabase,
  conversationIds: string[],
): Promise<Map<string, ConversationActivityPreview>> {
  if (conversationIds.length === 0) return new Map();

  const role = sql<
    "assistant" | "user"
  >`${juniorConversationEvents.payload}->>'role'`;
  const text = sql<string>`${juniorConversationEvents.payload}->>'text'`;
  const assistantFirst = sql<number>`case when ${role} = 'assistant' then 0 else 1 end`;
  const rows = await db
    .selectDistinctOn([juniorConversationEvents.conversationId], {
      conversationId: juniorConversationEvents.conversationId,
      createdAt: juniorConversationEvents.createdAt,
      role: role.as("role"),
      text: text.as("text"),
    })
    .from(juniorConversationEvents)
    .where(
      and(
        inArray(juniorConversationEvents.conversationId, conversationIds),
        eq(juniorConversationEvents.type, "message"),
        sql`${role} in ('assistant', 'user')`,
        isNotNull(sql`nullif(btrim(${text}), '')`),
      ),
    )
    .orderBy(
      juniorConversationEvents.conversationId,
      assistantFirst,
      desc(juniorConversationEvents.createdAt),
      desc(juniorConversationEvents.seq),
    );

  return new Map(
    rows.map((row) => [
      row.conversationId,
      {
        createdAt: row.createdAt.toISOString(),
        role: row.role,
        text: row.text,
      },
    ]),
  );
}
