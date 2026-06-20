/**
 * Drizzle source of truth for memory plugin SQL migrations.
 *
 * Update this schema first, then regenerate packaged migrations with
 * `pnpm --filter @sentry/junior-memory db:generate`.
 */
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
  MEMORY_SOURCE_PLATFORMS,
  MEMORY_SUBJECT_TYPES,
  MEMORY_TYPES,
} from "../types";

export const juniorMemoryMemories = pgTable(
  "junior_memory_memories",
  {
    id: text("id").primaryKey(),
    scope: text("scope", { enum: MEMORY_SCOPES }).notNull(),
    scopeKey: text("scope_key").notNull(),
    type: text("type", { enum: MEMORY_TYPES }).notNull(),
    subjectType: text("subject_type", { enum: MEMORY_SUBJECT_TYPES }).notNull(),
    subjectKey: text("subject_key"),
    content: text("content").notNull(),
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
      "junior_memory_memories_subject_type_check",
      sql`${table.subjectType} IN ('user', 'conversation', 'general')`,
    ),
    check(
      "junior_memory_memories_subject_key_check",
      sql`(${table.subjectType} = 'general' AND ${table.subjectKey} IS NULL) OR (${table.subjectType} IN ('user', 'conversation') AND ${table.subjectKey} IS NOT NULL AND length(${table.subjectKey}) > 0)`,
    ),
    check(
      "junior_memory_memories_source_platform_check",
      sql`${table.sourcePlatform} IN ('slack', 'local')`,
    ),
  ],
);
