/** Shared memory embedding normalization and provider validation. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { MEMORY_EMBEDDING_DIMENSIONS } from "./types";

const numberSchema = z.number().finite();
const nonEmptyStringSchema = z.string().min(1);
export const EMBEDDING_METRIC = "cosine";
const embeddingVectorSchema = z
  .array(numberSchema)
  .length(MEMORY_EMBEDDING_DIMENSIONS);
const embeddingResultSchema = z
  .object({
    costUsd: z.number().finite().nonnegative().optional(),
    dimensions: z.literal(MEMORY_EMBEDDING_DIMENSIONS),
    model: nonEmptyStringSchema,
    provider: nonEmptyStringSchema,
    vectors: z.array(embeddingVectorSchema),
  })
  .strict();

export interface MemoryEmbedding {
  model: string;
  provider: string;
  vector: number[];
}

export interface MemoryEmbeddingProvider {
  /** Embed normalized memory text for derived vector retrieval. */
  embedTexts(input: { texts: string[] }): Promise<{
    costUsd?: number;
    dimensions: number;
    model: string;
    provider: string;
    vectors: number[][];
  }>;
}

/** Normalize memory content before comparison, storage, or embedding. */
export function normalizeMemoryContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

/** Hash the exact normalized content represented by a derived embedding. */
export function hashEmbeddedContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Embed one non-empty memory or query with a validated provider response. */
export async function embedMemoryText(
  embedder: MemoryEmbeddingProvider,
  text: string,
): Promise<MemoryEmbedding> {
  const normalized = normalizeMemoryContent(text);
  if (!normalized) {
    throw new Error("Embedding text is required.");
  }
  const result = embeddingResultSchema.parse(
    await embedder.embedTexts({ texts: [normalized] }),
  );
  if (result.vectors.length !== 1) {
    throw new Error("Embedding provider returned an unexpected vector count.");
  }
  return {
    model: result.model,
    provider: result.provider,
    vector: result.vectors[0],
  };
}
