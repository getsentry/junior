import { sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { MemoryMetadata, MemorySubjectLabel } from "../types";

export const juniorMemoryMemories = pgTable(
  "junior_memory_memories",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    scopeKey: text("scope_key").notNull(),
    type: text("type").notNull(),
    sensitivity: text("sensitivity").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    sourcePlatform: text("source_platform").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceKind: text("source_kind").notNull(),
    idempotencyKey: text("idempotency_key"),
    subjectLabels: jsonb("subject_labels")
      .$type<MemorySubjectLabel[]>()
      .notNull()
      .default([]),
    metadata: jsonb("metadata").$type<MemoryMetadata>().notNull().default({}),
    confidence: doublePrecision("confidence"),
    observedAtMs: bigint("observed_at_ms", { mode: "number" }).notNull(),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    expiresAtMs: bigint("expires_at_ms", { mode: "number" }),
    supersededAtMs: bigint("superseded_at_ms", { mode: "number" }),
    supersededById: text("superseded_by_id"),
    archivedAtMs: bigint("archived_at_ms", { mode: "number" }),
    archiveReason: text("archive_reason"),
  },
  (table) => [
    index("junior_memory_memories_visible_idx")
      .on(table.scope, table.scopeKey, table.createdAtMs, table.id)
      .where(
        sql`${table.archivedAtMs} IS NULL AND ${table.supersededAtMs} IS NULL AND ${table.supersededById} IS NULL`,
      ),
    index("junior_memory_memories_expiration_idx")
      .on(table.expiresAtMs)
      .where(
        sql`${table.archivedAtMs} IS NULL AND ${table.expiresAtMs} IS NOT NULL`,
      ),
    uniqueIndex("junior_memory_memories_active_hash_idx")
      .on(table.scope, table.scopeKey, table.contentHash)
      .where(
        sql`${table.archivedAtMs} IS NULL AND ${table.supersededAtMs} IS NULL`,
      ),
    uniqueIndex("junior_memory_memories_idempotency_idx")
      .on(table.scope, table.scopeKey, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ],
);
