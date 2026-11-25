import { sql } from "drizzle-orm";
import type { ConversationContent } from "@/chat/conversations/sql/purge";
import { juniorTodos } from "@/db/schema";
import { deleteTodos } from "./store";

/**
 * The To-dos of a Conversation as purge content. Their titles and notes come
 * from the transcript, so they go with it.
 */
export const todosConversationContent: ConversationContent = {
  existsSql: (conversationId) =>
    sql`exists (select 1 from ${juniorTodos} where ${juniorTodos.conversationId} = ${conversationId})`,
  delete: deleteTodos,
};
