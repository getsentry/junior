import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

/**
 * What a Message carries: a stored file (`file`) or a web link that its text
 * names (`url`). Rows are owned by one Conversation, and a repeat of the same
 * thing in that Conversation reuses its row.
 */
export const juniorAttachments = pgTable(
  "junior_attachments",
  {
    id: text("id").primaryKey(),
    /** `file` or `url`. Only `file` rows have storage and file fields. */
    kind: text("kind").notNull().default("file"),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId, {
        onDelete: "cascade",
      }),
    /** Service that stores the file bytes. */
    storageProvider: text("storage_provider"),
    /**
     * Object key of the stored bytes. Null for a file that Junior records
     * without storing, such as a large Slack file.
     */
    storageKey: text("storage_key"),
    /** Provider that supplied the file. */
    provider: text("provider"),
    /** File id assigned by the source provider. */
    providerId: text("provider_id"),
    /**
     * File name of a file. The column keeps its old name until no worker
     * that reads `filename` runs.
     */
    title: text("filename"),
    contentType: text("content_type"),
    bytes: integer("bytes"),
    /** Web link of a `url` row, as its message text wrote it. */
    url: text("url"),
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
    // One `url` row per link in a Conversation. Writers already derive the
    // id from the pair; this keeps a writer that does not from adding a
    // second row.
    uniqueIndex("junior_attachments_conversation_url_idx")
      .on(table.conversationId, table.url)
      .where(sql`${table.url} IS NOT NULL`),
  ],
);

/**
 * Where each stored message event uses an Attachment. `seq` is the seq of the
 * first save of its message, as in the transcript. `position` is the 1-based
 * order of a link in the message text, and null for an Attachment that is not
 * in the text. No foreign keys, so creating the table locks no existing
 * table.
 */
export const juniorMessageAttachments = pgTable(
  "junior_message_attachments",
  {
    conversationId: text("conversation_id").notNull(),
    seq: integer("seq").notNull(),
    attachmentId: text("attachment_id").notNull(),
    position: integer("position"),
    /**
     * When the heartbeat next adds this link to the Conversation's linked
     * work (`chat/conversations/sent-links.ts`). Set for the links of a
     * person's Turn input Message, and null when nothing is left to do.
     */
    attachDueAt: timestamptz("attach_due_at"),
  },
  (table) => [
    primaryKey({
      name: "junior_message_attachments_pk",
      columns: [table.conversationId, table.seq, table.attachmentId],
    }),
    // The heartbeat reads only the due links, which are few.
    index("junior_message_attachments_attach_due_idx")
      .on(table.attachDueAt)
      .where(sql`${table.attachDueAt} IS NOT NULL`),
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
