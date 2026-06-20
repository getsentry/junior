import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  MEMORY_SCOPES,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCE_PLATFORMS,
  MEMORY_TYPES,
} from "../types";

export const juniorMemoryMemories = pgTable(
  "junior_memory_memories",
  {
    id: text("id").primaryKey(),
    scope: text("scope", { enum: MEMORY_SCOPES }).notNull(),
    scopeKey: text("scope_key").notNull(),
    type: text("type", { enum: MEMORY_TYPES }).notNull(),
    sensitivity: text("sensitivity", { enum: MEMORY_SENSITIVITIES }).notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    sourcePlatform: text("source_platform", {
      enum: MEMORY_SOURCE_PLATFORMS,
    }).notNull(),
    sourceKey: text("source_key").notNull(),
    idempotencyKey: text("idempotency_key"),
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
      .on(table.scope, table.scopeKey, table.createdAtMs.desc(), table.id)
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
        sql`${table.archivedAtMs} IS NULL AND ${table.supersededAtMs} IS NULL AND ${table.supersededById} IS NULL`,
      ),
    uniqueIndex("junior_memory_memories_idempotency_idx")
      .on(table.scope, table.scopeKey, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    check(
      "junior_memory_memories_scope_check",
      sql`${table.scope} IN ('personal', 'conversation')`,
    ),
    check(
      "junior_memory_memories_type_check",
      sql`${table.type} IN (
        'preference',
        'identity',
        'relationship',
        'knowledge',
        'context',
        'event',
        'task',
        'observation'
      )`,
    ),
    check(
      "junior_memory_memories_sensitivity_check",
      sql`${table.sensitivity} IN ('public', 'personal', 'sensitive')`,
    ),
    check(
      "junior_memory_memories_source_platform_check",
      sql`${table.sourcePlatform} IN ('slack', 'local')`,
    ),
  ],
);
