/** Derived embedding index rules for memory create and retrieval operations. */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { juniorMemoryEmbeddings } from "./db/schema";
import type { MemoryDb } from "./memories";
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

/** Store a best-effort derived embedding without blocking memory persistence. */
export async function storeMemoryEmbedding(args: {
  content: string;
  db: MemoryDb;
  embedder?: MemoryEmbeddingProvider;
  embedding?: MemoryEmbedding;
  memoryId: string;
  nowMs: number;
}): Promise<void> {
  if (!args.embedder && !args.embedding) {
    return;
  }
  try {
    const existing = await args.db
      .select({ memoryId: juniorMemoryEmbeddings.memoryId })
      .from(juniorMemoryEmbeddings)
      .where(eq(juniorMemoryEmbeddings.memoryId, args.memoryId))
      .limit(1);
    if (existing[0]) {
      return;
    }
  } catch {
    return;
  }
  let embedding: MemoryEmbedding;
  if (args.embedding) {
    embedding = args.embedding;
  } else {
    const embedder = args.embedder;
    if (!embedder) {
      return;
    }
    try {
      embedding = await embedMemoryText(embedder, args.content);
    } catch {
      return;
    }
  }
  try {
    await args.db
      .insert(juniorMemoryEmbeddings)
      .values({
        contentHash: hashEmbeddedContent(args.content),
        createdAtMs: args.nowMs,
        dimensions: MEMORY_EMBEDDING_DIMENSIONS,
        embedding: embedding.vector,
        memoryId: args.memoryId,
        metric: EMBEDDING_METRIC,
        model: embedding.model,
        provider: embedding.provider,
      })
      .onConflictDoNothing();
  } catch {
    return;
  }
}
