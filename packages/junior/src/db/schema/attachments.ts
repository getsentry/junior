import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

/**
 * Lifecycle of one attachment row. `live` bytes are readable until
 * `expiresAt`. `delete_requested` bytes are not readable and wait for GC,
 * which deletes the bytes and then the row. A new write of the same file can
 * move a row back to `live` with new bytes and a new `expiresAt`.
 */
type AttachmentStatus = "live" | "delete_requested";

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
    storageKey: text("storage_key").notNull(),
    /** Provider that supplied the file. */
    provider: text("provider"),
    /** File id assigned by the source provider. */
    providerId: text("provider_id"),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    visionSummary: text("vision_summary"),
    createdAt: timestamptz("created_at").notNull(),
    // Defaults serve writers from an older deploy that do not set these. The
    // interval matches `ATTACHMENT_RETENTION_MS`.
    status: text("status").$type<AttachmentStatus>().notNull().default("live"),
    /** Time when the bytes at `storageKey` stop being readable. */
    expiresAt: timestamptz("expires_at")
      .notNull()
      .default(sql`now() + interval '30 days'`),
    /** Time of the `delete_requested` transition. */
    deleteRequestedAt: timestamptz("delete_requested_at"),
  },
  (table) => [
    check(
      "junior_attachments_status_check",
      sql`${table.status} in ('live', 'delete_requested')`,
    ),
    index("junior_attachments_conversation_idx").on(table.conversationId),
    index("junior_attachments_provider_idx").on(
      table.conversationId,
      table.provider,
      table.providerId,
    ),
    index("junior_attachments_gc_idx").on(
      table.storageProvider,
      table.status,
      table.expiresAt,
    ),
  ],
);
