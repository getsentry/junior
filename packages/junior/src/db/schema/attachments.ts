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
    slackFileId: text("slack_file_id"),
    visionSummary: text("vision_summary"),
    createdAt: timestamptz("created_at").notNull(),
    /** Set when conversation purge marks the attachment unavailable. */
    deleteRequestedAt: timestamptz("delete_requested_at"),
  },
  (table) => [
    index("junior_attachments_conversation_idx").on(table.conversationId),
    index("junior_attachments_slack_file_idx").on(
      table.conversationId,
      table.slackFileId,
    ),
    index("junior_attachments_gc_idx").on(
      table.provider,
      table.deleteRequestedAt,
      table.createdAt,
    ),
  ],
);
