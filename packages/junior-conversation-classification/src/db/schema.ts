/** Drizzle source of truth for conversation-classification migrations. */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  doublePrecision,
  index,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

export const juniorConversationClassifications = pgTable(
  "junior_conversation_classifications",
  {
    taskId: text("task_id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    turnId: text("turn_id").notNull(),
    taxonomyVersion: text("taxonomy_version").notNull(),
    categoryId: text("category_id").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    modelId: text("model_id"),
    ownerKey: text("owner_key").notNull(),
    visibility: text("visibility").$type<"public" | "private">().notNull(),
    turnCompletedAtMs: bigint("turn_completed_at_ms", {
      mode: "number",
    }).notNull(),
    classifiedAtMs: bigint("classified_at_ms", { mode: "number" }).notNull(),
    expiresAtMs: bigint("expires_at_ms", { mode: "number" }).notNull(),
  },
  (table) => [
    check(
      "junior_conversation_classifications_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    index("junior_conversation_classifications_category_idx").on(
      table.taxonomyVersion,
      table.categoryId,
    ),
    index("junior_conversation_classifications_conversation_idx").on(
      table.conversationId,
      table.turnCompletedAtMs,
    ),
    index("junior_conversation_classifications_expiry_idx").on(
      table.expiresAtMs,
    ),
  ],
);
