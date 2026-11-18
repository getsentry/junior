import { inArray, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import { userMessageQueries } from "@/chat/conversations/sql/last-message";

function latestIso(times: Array<Date | null>): string | undefined {
  const ms = times.flatMap((at) => (at ? [at.getTime()] : []));
  return ms.length > 0 ? new Date(Math.max(...ms)).toISOString() : undefined;
}

/** Read the latest true user message time for each selected conversation. */
export async function readLastUserMessageAtByConversation(
  db: JuniorDatabase,
  conversationIds: string[],
): Promise<Map<string, string>> {
  if (conversationIds.length === 0) return new Map();

  const queries = userMessageQueries(db);
  const instruction = queries.instruction.as("latest_instruction");
  const message = queries.message.as("latest_user_message");
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
    const at = latestIso([instructionAt, messageAt]);
    if (at) result.set(conversationId, at);
  }
  return result;
}
