import { index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { juniorUsers } from "./users";
import { timestamptz } from "./timestamps";

/**
 * Materialized personal-feed membership for one linked user on one root
 * conversation. Rows come from the root actor and from durable human user
 * message authors.
 */
export const juniorConversationParticipants = pgTable(
  "junior_conversation_participants",
  {
    userId: text("user_id")
      .notNull()
      .references(() => juniorUsers.id),
    rootConversationId: text("root_conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId),
    lastMessageAt: timestamptz("last_message_at").notNull(),
    archivedAt: timestamptz("archived_at"),
  },
  (table) => [
    primaryKey({
      name: "junior_conversation_participants_user_root_pk",
      columns: [table.userId, table.rootConversationId],
    }),
    index("junior_conversation_participants_user_activity_idx").on(
      table.userId,
      table.lastMessageAt.desc(),
    ),
    index("junior_conversation_participants_root_idx").on(
      table.rootConversationId,
    ),
  ],
);
