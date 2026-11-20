/**
 * Derived vector index helpers shared by memory writes, reads, and reembed.
 *
 * Vectors are stored per memory and per model. Reads only compare vectors from
 * the same model and size as the query vector.
 */
import { createHash } from "node:crypto";
import type { PluginEmbedder } from "@sentry/junior-plugin-api";
import {
  cosineDistance,
  guardedCosineDistance,
  parseEmbeddingBatch as parseSharedEmbeddingBatch,
  type EmbeddingBatch,
  type EmbeddingVector,
} from "@/db/embeddings";
import { and, eq, sql, type Column, type SQL } from "drizzle-orm";
import { juniorMemoryEmbeddings } from "@/db/schema/memory";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  type MemoryEmbeddingMetric,
} from "./types";

export const EMBEDDING_METRIC: MemoryEmbeddingMetric = "cosine";

/** Host embedder that memory writes, reads, and the backfill use. */
export type MemoryEmbeddingProvider = PluginEmbedder;

export type MemoryEmbedding = EmbeddingVector;

/** Validate an embedder result against the stored vector sizes and text count. */
export function parseEmbeddingBatch(
  raw: unknown,
  textCount: number,
): EmbeddingBatch {
  return parseSharedEmbeddingBatch(raw, {
    dimensions: MEMORY_EMBEDDING_DIMENSIONS,
    textCount,
  });
}

/** Hash stored memory content so reads can skip vectors of changed content. */
export function hashEmbeddedContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Reject a query vector of a size that no stored vector can have. */
function assertStoredSize(embedding: MemoryEmbedding): void {
  if (
    !(MEMORY_EMBEDDING_DIMENSIONS as readonly number[]).includes(
      embedding.vector.length,
    )
  ) {
    throw new Error("Unsupported embedding vector size.");
  }
}

function vectorSize(embedding: MemoryEmbedding): SQL {
  assertStoredSize(embedding);
  // A literal, not a bind parameter, so Postgres can match the partial index.
  return sql.raw(String(embedding.vector.length));
}

/** Cosine distance to a query vector, cast to match its HNSW index. */
export function embeddingDistance(embedding: MemoryEmbedding): SQL {
  assertStoredSize(embedding);
  // Wrapped, so the result has the SQL type of this package's drizzle-orm.
  return sql`${cosineDistance({
    column: juniorMemoryEmbeddings.embedding,
    query: embedding.vector,
    type: "vector",
  })}`;
}

/** Cosine distance cutoff that never casts a stored vector of another size. */
export function embeddingWithinDistance(
  embedding: MemoryEmbedding,
  maxDistance: number,
): SQL {
  assertStoredSize(embedding);
  return sql`${guardedCosineDistance({
    column: juniorMemoryEmbeddings.embedding,
    dimensions: juniorMemoryEmbeddings.dimensions,
    query: embedding.vector,
    type: "vector",
  })} <= ${maxDistance}`;
}

type EmbeddingModelColumns = Record<
  "dimensions" | "metric" | "model" | "provider",
  Column
>;

/**
 * Match stored vectors from the same model and size as a query vector. Pass
 * columns to match rows of a subquery over the embeddings table.
 */
export function sameEmbeddingModel(
  embedding: MemoryEmbedding,
  columns: EmbeddingModelColumns = juniorMemoryEmbeddings,
): SQL {
  return and(
    eq(columns.provider, embedding.provider),
    eq(columns.model, embedding.model),
    sql`${columns.dimensions} = ${vectorSize(embedding)}`,
    eq(columns.metric, EMBEDDING_METRIC),
  ) as SQL;
}

/** The only vector size with an HNSW index (migration 0013). */
const HNSW_INDEX_DIMENSIONS = 1024;

/** Whether stored vectors of the query vector size have an HNSW index. */
export function hasHnswIndex(embedding: MemoryEmbedding): boolean {
  return embedding.vector.length === HNSW_INDEX_DIMENSIONS;
}

/**
 * Match stored vectors of the query vector size only. This is the predicate of
 * the partial HNSW index, so a query with only this filter can use the index.
 */
export function sameEmbeddingSize(embedding: MemoryEmbedding): SQL {
  return sql`${juniorMemoryEmbeddings.dimensions} = ${vectorSize(embedding)}`;
}
