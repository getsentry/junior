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
    /** Service that stores the file bytes. */
    storageProvider: text("storage_provider").notNull(),
    /**
     * Object key of the stored bytes. Null for a file that Junior records
     * without storing, such as a large Slack file.
     */
    storageKey: text("storage_key"),
    /** Provider that supplied the file. */
    provider: text("provider"),
    /** File id assigned by the source provider. */
    providerId: text("provider_id"),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    /** Digest of the stored bytes. Null when `storage_key` is null. */
    sha256: text("sha256"),
    visionSummary: text("vision_summary"),
    createdAt: timestamptz("created_at").notNull(),
    /** Set when conversation purge marks the attachment unavailable. */
    deleteRequestedAt: timestamptz("delete_requested_at"),
  },
  (table) => [
    index("junior_attachments_conversation_idx").on(table.conversationId),
    index("junior_attachments_provider_idx").on(
      table.conversationId,
      table.provider,
      table.providerId,
    ),
    index("junior_attachments_gc_idx").on(
      table.storageProvider,
      table.deleteRequestedAt,
      table.createdAt,
    ),
  ],
);

/**
 * Browser uploads that wait for a web Message.
 *
 * A row binds one object key to the viewer, Conversation, and Message
 * idempotency key that asked for it. A Message turns the upload into a
 * `junior_attachments` row with the same id. Cleanup deletes the object of an
 * upload that no Message used.
 */
export const juniorAttachmentUploads = pgTable(
  "junior_attachment_uploads",
  {
    id: text("id").primaryKey(),
    /** No foreign key: a new Conversation has no row until its first send. */
    conversationId: text("conversation_id").notNull(),
    userId: text("user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    storageProvider: text("storage_provider").notNull(),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    /** Size that the browser declared and the upload target allows. */
    bytes: integer("bytes").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    index("junior_attachment_uploads_gc_idx").on(
      table.storageProvider,
      table.createdAt,
    ),
  ],
);
