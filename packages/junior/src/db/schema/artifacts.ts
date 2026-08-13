import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

/** Durable metadata for conversation-owned public artifacts. */
export const juniorArtifacts = pgTable(
  "junior_artifacts",
  {
    /** Public identity used in `/public/artifacts/<id>.<ext>`. */
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sha256: text("sha256").notNull(),
    ext: text("ext").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    public: boolean("public").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    /** Set when the artifact should stop being served publicly. */
    deleteRequestedAt: timestamptz("delete_requested_at"),
  },
  (table) => [
    uniqueIndex("junior_artifacts_conversation_sha_uidx").on(
      table.conversationId,
      table.sha256,
    ),
    index("junior_artifacts_gc_idx").on(
      table.deleteRequestedAt,
      table.createdAt,
    ),
    index("junior_artifacts_conversation_idx").on(table.conversationId),
  ],
);
