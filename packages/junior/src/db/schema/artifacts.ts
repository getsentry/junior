import { sql } from "drizzle-orm";
import {
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

/** Durable metadata for conversation-owned artifacts. */
export const juniorArtifacts = pgTable(
  "junior_artifacts",
  {
    /** Row identity. A public row serves at `/public/artifacts/<id>.<ext>`. */
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sha256: text("sha256").notNull(),
    ext: text("ext").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    /**
     * Path under the Sandbox `artifacts/` directory for a live file. Null for
     * a public frozen copy, such as a published image.
     */
    path: text("path"),
    visibility: text("visibility")
      .$type<ArtifactVisibility>()
      .notNull()
      // A write that omits it gets the narrowest audience, never public.
      .default("conversation"),
    createdAt: timestamptz("created_at").notNull(),
    /** Set when the artifact is unpublished or its live file is deleted. */
    deleteRequestedAt: timestamptz("delete_requested_at"),
    /** When a public artifact stops serving. Null serves until unpublished. */
    expiresAt: timestamptz("expires_at"),
  },
  (table) => [
    check(
      "junior_artifacts_visibility_check",
      sql`${table.visibility} in ('conversation', 'internal', 'public')`,
    ),
    // Live files have a path and are never public. Public rows are frozen
    // copies with no path.
    check(
      "junior_artifacts_path_visibility_check",
      sql`(${table.path} is null) = (${table.visibility} = 'public')`,
    ),
    uniqueIndex("junior_artifacts_conversation_path_uidx").on(
      table.conversationId,
      table.path,
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
