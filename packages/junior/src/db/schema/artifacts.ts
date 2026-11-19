import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

/** Who can read an artifact. Public rows serve without authentication. */
type ArtifactVisibility = "conversation" | "internal" | "public";

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
    visibility: text("visibility")
      .$type<ArtifactVisibility>()
      .notNull()
      // Only so the previous runtime's inserts stay public during rollout.
      // Drop it together with `public`.
      .default("public"),
    /**
     * Replaced by `visibility`. Nothing reads or writes it. It stays, with a
     * default, while the previous runtime still reads it during rollout.
     */
    public: boolean("public").notNull().default(true),
    createdAt: timestamptz("created_at").notNull(),
    /** Set when the artifact should stop being served publicly. */
    deleteRequestedAt: timestamptz("delete_requested_at"),
  },
  (table) => [
    check(
      "junior_artifacts_visibility_check",
      sql`${table.visibility} in ('conversation', 'internal', 'public')`,
    ),
    // The previous runtime upserts on this index. Drop it together with
    // `public`; publishing then uses only the public-row index below.
    uniqueIndex("junior_artifacts_conversation_sha_uidx").on(
      table.conversationId,
      table.sha256,
    ),
    uniqueIndex("junior_artifacts_public_sha_uidx")
      .on(table.conversationId, table.sha256)
      .where(sql`${table.visibility} = 'public'`),
    index("junior_artifacts_gc_idx").on(
      table.deleteRequestedAt,
      table.createdAt,
    ),
    index("junior_artifacts_conversation_idx").on(table.conversationId),
  ],
);
