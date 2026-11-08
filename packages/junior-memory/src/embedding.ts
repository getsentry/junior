/**
 * Derived vector index helpers shared by memory writes, reads, and reembed.
 *
 * Vectors are stored per memory and per model. Reads only compare vectors from
 * the same model and size as the query vector.
 */
import { createHash } from "node:crypto";
import { and, eq, sql, type Column, type SQL } from "drizzle-orm";
import * as z from "zod";
import { juniorMemoryEmbeddings } from "./db/schema";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  type MemoryEmbeddingDimensions,
  type MemoryEmbeddingMetric,
} from "./types";

export const EMBEDDING_METRIC: MemoryEmbeddingMetric = "cosine";

export interface MemoryEmbeddingProvider {
  /** Model id that embedTexts() uses and reports. */
  model: string;
  /** Provider name that embedTexts() reports. */
  provider: string;
  /** Embed normalized memory text for derived vector retrieval. */
  embedTexts(input: {
    inputType?: "document" | "query";
    texts: string[];
  }): Promise<{
    costUsd?: number;
    dimensions: number;
    model: string;
    provider: string;
    vectors: number[][];
  }>;
}

interface MemoryEmbeddingBatch {
  dimensions: MemoryEmbeddingDimensions;
  model: string;
  provider: string;
  vectors: number[][];
}

export interface MemoryEmbedding {
  model: string;
  provider: string;
  vector: number[];
}

const nonEmptyStringSchema = z.string().min(1);
const embeddingResultSchema = z
  .object({
    costUsd: z.number().finite().nonnegative().optional(),
    dimensions: z
      .number()
      .int()
      .refine(
        (value): value is MemoryEmbeddingDimensions =>
          (MEMORY_EMBEDDING_DIMENSIONS as readonly number[]).includes(value),
        { message: "Unsupported embedding vector size." },
      ),
    model: nonEmptyStringSchema,
    provider: nonEmptyStringSchema,
    vectors: z.array(z.array(z.number().finite())),
  })
  .strict();

/** Validate an embedder result against the stored vector sizes and text count. */
export function parseEmbeddingBatch(
  raw: unknown,
  textCount: number,
): MemoryEmbeddingBatch {
  const result = embeddingResultSchema.parse(raw);
  if (result.vectors.length !== textCount) {
    throw new Error("Embedding provider returned an unexpected vector count.");
  }
  if (result.vectors.some((vector) => vector.length !== result.dimensions)) {
    throw new Error("Embedding provider returned an unexpected vector size.");
  }
  return {
    dimensions: result.dimensions as MemoryEmbeddingDimensions,
    model: result.model,
    provider: result.provider,
    vectors: result.vectors,
  };
}

/** Hash stored memory content so reads can skip vectors of changed content. */
export function hashEmbeddedContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function vectorSize(embedding: MemoryEmbedding): SQL {
  const dimensions = embedding.vector.length;
  if (
    !(MEMORY_EMBEDDING_DIMENSIONS as readonly number[]).includes(dimensions)
  ) {
    throw new Error("Unsupported embedding vector size.");
  }
  // A literal, not a bind parameter, so Postgres can match the partial index.
  return sql.raw(String(dimensions));
}

/** Cosine distance to a query vector, cast to match its HNSW index. */
export function embeddingDistance(embedding: MemoryEmbedding): SQL {
  const size = vectorSize(embedding);
  return sql`(${juniorMemoryEmbeddings.embedding}::vector(${size})) <=> ${JSON.stringify(embedding.vector)}::vector(${size})`;
}

/**
 * Cosine distance cutoff that never casts a stored vector of another size.
 * Postgres does not promise to check `dimensions` before other WHERE terms,
 * and the cast fails on a vector of another size. CASE fixes the order.
 */
export function embeddingWithinDistance(
  embedding: MemoryEmbedding,
  maxDistance: number,
): SQL {
  return sql`CASE WHEN ${juniorMemoryEmbeddings.dimensions} = ${vectorSize(embedding)} THEN ${embeddingDistance(embedding)} END <= ${maxDistance}`;
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
