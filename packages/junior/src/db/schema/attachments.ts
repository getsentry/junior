import { index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

/** Durable metadata for files owned by one conversation. */
export const juniorAttachments = pgTable(
  "junior_attachments",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId, {
        onDelete: "cascade",
      }),
    toolCallId: text("tool_call_id").notNull(),
    position: integer("position").notNull(),
    provider: text("provider").notNull(),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    readyAt: timestamptz("ready_at"),
    deleteRequestedAt: timestamptz("delete_requested_at"),
  },
  (table) => [
    uniqueIndex("junior_attachments_tool_position_idx").on(
      table.conversationId,
      table.toolCallId,
      table.position,
    ),
    index("junior_attachments_gc_idx").on(
      table.provider,
      table.deleteRequestedAt,
      table.createdAt,
    ),
  ],
);
