import { inArray, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import { latestUserMessageQuery } from "@/chat/conversations/sql/last-message";

/** Read the latest true user message time for each selected conversation. */
export async function readLastUserMessageAtByConversation(
  db: JuniorDatabase,
  conversationIds: string[],
): Promise<Map<string, string>> {
  if (conversationIds.length === 0) return new Map();

  const message = latestUserMessageQuery(db).as("latest_user_message");
  const rows = await db
    .select({
      conversationId: juniorConversations.conversationId,
      messageAt: message.createdAt,
    })
    .from(juniorConversations)
    .leftJoinLateral(message, sql`true`)
    .where(inArray(juniorConversations.conversationId, conversationIds));

  const result = new Map<string, string>();
  for (const { conversationId, messageAt } of rows) {
    if (messageAt) result.set(conversationId, messageAt.toISOString());
  }
  return result;
}
