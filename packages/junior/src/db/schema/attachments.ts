import { index, integer, pgTable, text } from "drizzle-orm/pg-core";
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
    provider: text("provider").notNull(),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    /** Set after object storage accepts the bytes. Null means the write is incomplete. */
    readyAt: timestamptz("ready_at"),
    /** Set when conversation purge marks the attachment unavailable. */
    deleteRequestedAt: timestamptz("delete_requested_at"),
  },
  (table) => [
    index("junior_attachments_conversation_idx").on(table.conversationId),
    index("junior_attachments_gc_idx").on(
      table.provider,
      table.deleteRequestedAt,
      table.createdAt,
    ),
  ],
);
