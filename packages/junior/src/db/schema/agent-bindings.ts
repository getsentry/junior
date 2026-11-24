import { pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";

export const juniorAgentBindings = pgTable(
  "junior_agent_bindings",
  {
    parentConversationId: text("parent_conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId),
    name: text("name").notNull(),
    childConversationId: text("child_conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId),
  },
  (table) => [
    primaryKey({
      columns: [table.parentConversationId, table.name],
    }),
    uniqueIndex("junior_agent_bindings_child_idx").on(
      table.childConversationId,
    ),
  ],
);
