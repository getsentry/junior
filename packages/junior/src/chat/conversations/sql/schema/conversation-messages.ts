import { index, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { juniorIdentities } from "./identities";
import { timestamptz } from "./timestamps";
import type { ConversationMessageRole } from "@/chat/conversations/messages";

/**
 * Visible conversation transcript: one immutable row per source message keyed by
 * `(conversation_id, message_id)`. `role`/`text`/`author_identity_id`/`created_at`
 * never change after insert; `replied_at` is the only mutable delivery mark.
 */
export const juniorConversationMessages = pgTable(
  "junior_conversation_messages",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId),
    messageId: text("message_id").notNull(),
    role: text("role").$type<ConversationMessageRole>().notNull(),
    authorIdentityId: text("author_identity_id").references(
      () => juniorIdentities.id,
    ),
    text: text("text").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    repliedAt: timestamptz("replied_at"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.messageId] }),
    index("junior_conversation_messages_activity_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);
