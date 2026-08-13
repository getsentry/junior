import { boolean, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

/** Durable metadata for content-addressed artifacts Junior may serve publicly. */
export const juniorArtifacts = pgTable(
  "junior_artifacts",
  {
    sha256: text("sha256").primaryKey(),
    ext: text("ext").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    public: boolean("public").notNull(),
    /**
     * Conversation that last published this artifact.
     * Unpublish is limited to this conversation id.
     */
    conversationId: text("conversation_id").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    /** Set when the artifact should stop being served publicly. */
    deleteRequestedAt: timestamptz("delete_requested_at"),
  },
  (table) => [
    index("junior_artifacts_gc_idx").on(
      table.deleteRequestedAt,
      table.createdAt,
    ),
    index("junior_artifacts_conversation_idx").on(table.conversationId),
  ],
);
