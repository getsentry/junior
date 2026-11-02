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
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_METRICS,
  MEMORY_SCOPES,
  MEMORY_SIGNALS,
  MEMORY_SOURCE_PLATFORMS,
  MEMORY_SUBJECT_TYPES,
  MEMORY_KINDS,
} from "../types";

/**
 * pgvector column without a fixed size. Rows from different embedding models
 * can have different sizes; the dimensions column records each row's size.
 */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(value) {
    return value.slice(1, -1).split(",").map(Number);
  },
});

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const juniorMemoryMemories = pgTable(
  "junior_memory_memories",
  {
    id: text("id").primaryKey(),
    scope: text("scope", { enum: MEMORY_SCOPES }).notNull(),
    scopeKey: text("scope_key").notNull(),
    kind: text("type", { enum: MEMORY_KINDS }).notNull(),
    subjectType: text("subject_type", { enum: MEMORY_SUBJECT_TYPES }).notNull(),
    subjectKey: text("subject_key"),
    content: text("content").notNull(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('english', "content")`,
    ),
    sourcePlatform: text("source_platform", {
      enum: MEMORY_SOURCE_PLATFORMS,
    }).notNull(),
    sourceKey: text("source_key").notNull(),
    /** Location where Junior learned the memory, when known. */
    locationId: text("location_id"),
    /** Conversation where Junior learned the memory, when known. */
    conversationId: text("conversation_id"),
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
    index("junior_memory_memories_search_idx")
      .using("gin", table.scope, table.scopeKey, table.searchVector)
      .where(
        sql`${table.archivedAtMs} IS NULL AND ${table.supersededAtMs} IS NULL AND ${table.supersededById} IS NULL`,
      ),
    uniqueIndex("junior_memory_memories_idempotency_idx")
      .on(table.scope, table.scopeKey, table.idempotencyKey)
      .where(
        sql`${table.idempotencyKey} IS NOT NULL AND ${table.archivedAtMs} IS NULL AND ${table.supersededAtMs} IS NULL AND ${table.supersededById} IS NULL`,
      ),
    check(
      "junior_memory_memories_scope_check",
      sql`${table.scope} IN ('private', 'public')`,
    ),
    check(
      "junior_memory_memories_kind_check",
      sql`${table.kind} IN (
        'preference',
        'procedure',
        'knowledge'
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
      sql`${table.sourcePlatform} IN ('slack', 'local', 'web')`,
    ),
  ],
);

export const juniorMemoryEmbeddings = pgTable(
  "junior_memory_embeddings",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => juniorMemoryMemories.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    metric: text("metric", { enum: MEMORY_EMBEDDING_METRICS }).notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: vector("embedding").notNull(),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  },
  (table) => [
    // One vector per memory per model, so a new model can be backfilled while
    // reads still use the old one.
    primaryKey({ columns: [table.memoryId, table.provider, table.model] }),
    index("junior_memory_embeddings_model_idx").on(
      table.provider,
      table.model,
      table.dimensions,
      table.metric,
    ),
    // Cosine ANN for vector recall/search, one index per vector size. Queries
    // must use the same cast and a literal dimensions filter to use it.
    ...MEMORY_EMBEDDING_DIMENSIONS.map((dimensions) =>
      index(`junior_memory_embeddings_embedding_${dimensions}_hnsw_idx`)
        .using(
          "hnsw",
          sql`(${table.embedding}::vector(${sql.raw(String(dimensions))})) vector_cosine_ops`,
        )
        .with({ m: 16, ef_construction: 64 })
        .where(sql`${table.dimensions} = ${sql.raw(String(dimensions))}`),
    ),
    check(
      "junior_memory_embeddings_metric_check",
      sql`${table.metric} IN ('cosine')`,
    ),
    check(
      "junior_memory_embeddings_dimensions_check",
      sql`${table.dimensions} IN (${sql.raw(MEMORY_EMBEDDING_DIMENSIONS.join(", "))}) AND vector_dims(${table.embedding}) = ${table.dimensions}`,
    ),
  ],
);

/**
 * Thin log of signals about stored memories, such as a capture that resolved
 * to an existing memory. Callers count recent rows to weigh memories.
 */
export const juniorMemorySignals = pgTable(
  "junior_memory_signals",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => juniorMemoryMemories.id, { onDelete: "cascade" }),
    signal: text("signal", { enum: MEMORY_SIGNALS }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    /** Conversation where Junior saw the signal, when known. */
    conversationId: text("conversation_id"),
    observedAtMs: bigint("observed_at_ms", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.memoryId, table.signal, table.idempotencyKey],
    }),
    index("junior_memory_signals_observed_idx").on(
      table.memoryId,
      table.signal,
      table.observedAtMs,
    ),
    check(
      "junior_memory_signals_signal_check",
      sql`${table.signal} IN ('duplicate')`,
    ),
  ],
);
