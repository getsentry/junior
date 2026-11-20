import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { juniorUsers } from "./users";
import { timestamptz } from "./timestamps";

/**
 * How far one signed-in user has read one Conversation transcript.
 *
 * `last_read_seq` is the event sequence of the last transcript row the user
 * saw. It only moves forward, so clients on several devices can write in any
 * order.
 */
export const juniorConversationReadPositions = pgTable(
  "junior_conversation_read_positions",
  {
    userId: text("user_id")
      .notNull()
      .references(() => juniorUsers.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId),
    lastReadSeq: integer("last_read_seq").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_conversation_read_positions_user_conversation_pk",
      columns: [table.userId, table.conversationId],
    }),
  ],
);
