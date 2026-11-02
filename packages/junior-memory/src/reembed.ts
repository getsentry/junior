/**
 * One-off backfill of memory vectors for the configured embedding model.
 *
 * Use it to move memory to a new embedding model. Reads only use vectors of
 * the model that embeds the query, so run it before and after the model
 * change. It is safe to run again: it only embeds memories that have no
 * current vector for the model, and it commits each batch on its own.
 */
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import {
  EMBEDDING_METRIC,
  hashEmbeddedContent,
  parseEmbeddingBatch,
  type MemoryEmbeddingProvider,
} from "./embedding";
import { normalizeContent, type MemoryDb } from "./store";

export interface ReembedProgress {
  /** Memories embedded so far. */
  embedded: number;
  model: string;
  provider: string;
  /** Memories checked so far. */
  scanned: number;
}

export interface ReembedResult {
  embedded: number;
  /** Unset when no memory needed a vector. */
  model?: string;
  provider?: string;
  scanned: number;
}

type MemoryRow = { content: string; id: string };
type EmbeddingModel = { model: string; provider: string };

/** Drop memories that already have a vector of this model for their content. */
async function withoutCurrentVector(
  db: MemoryDb,
  memories: MemoryRow[],
  target: EmbeddingModel,
): Promise<MemoryRow[]> {
  const current = await db
    .select({
      contentHash: juniorMemoryEmbeddings.contentHash,
      memoryId: juniorMemoryEmbeddings.memoryId,
    })
    .from(juniorMemoryEmbeddings)
    .where(
      and(
        inArray(
          juniorMemoryEmbeddings.memoryId,
          memories.map((memory) => memory.id),
        ),
        eq(juniorMemoryEmbeddings.provider, target.provider),
        eq(juniorMemoryEmbeddings.model, target.model),
      ),
    );
  const hashById = new Map(
    current.map((row) => [row.memoryId, row.contentHash]),
  );
  return memories.filter(
    (memory) => hashById.get(memory.id) !== hashEmbeddedContent(memory.content),
  );
}

/** Embed every live memory that has no current vector for the embedder's model. */
export async function reembedMemories(args: {
  batchSize: number;
  db: MemoryDb;
  embedder: MemoryEmbeddingProvider;
  now?: () => number;
  onBatch?: (progress: ReembedProgress) => Promise<void> | void;
}): Promise<ReembedResult> {
  const now = args.now ?? Date.now;
  let afterId: string | undefined;
  let embedded = 0;
  let scanned = 0;
  // The embedder does not name its model before the first call. The first
  // batch is embedded in full; later batches skip current vectors up front.
  let target: EmbeddingModel | undefined;

  for (;;) {
    const page = await args.db
      .select({
        content: juniorMemoryMemories.content,
        id: juniorMemoryMemories.id,
      })
      .from(juniorMemoryMemories)
      .where(
        and(
          isNull(juniorMemoryMemories.archivedAtMs),
          isNull(juniorMemoryMemories.supersededAtMs),
          isNull(juniorMemoryMemories.supersededById),
          afterId === undefined
            ? undefined
            : gt(juniorMemoryMemories.id, afterId),
        ),
      )
      .orderBy(asc(juniorMemoryMemories.id))
      .limit(args.batchSize);
    const last = page.at(-1);
    if (!last) {
      break;
    }
    afterId = last.id;
    scanned += page.length;

    const pending = target
      ? await withoutCurrentVector(args.db, page, target)
      : page;
    if (pending.length === 0) {
      continue;
    }

    const batch = parseEmbeddingBatch(
      await args.embedder.embedTexts({
        inputType: "document",
        texts: pending.map((memory) => normalizeContent(memory.content)),
      }),
      pending.length,
    );
    if (
      target &&
      (target.provider !== batch.provider || target.model !== batch.model)
    ) {
      throw new Error("The embedding model changed during the backfill.");
    }
    const vectorById = new Map(
      pending.map((memory, index) => [memory.id, batch.vectors[index]!]),
    );
    const missing = target
      ? pending
      : await withoutCurrentVector(args.db, pending, batch);
    target = { model: batch.model, provider: batch.provider };
    if (missing.length === 0) {
      continue;
    }

    const createdAtMs = now();
    await args.db
      .insert(juniorMemoryEmbeddings)
      .values(
        missing.map((memory) => ({
          contentHash: hashEmbeddedContent(memory.content),
          createdAtMs,
          dimensions: batch.dimensions,
          embedding: vectorById.get(memory.id)!,
          memoryId: memory.id,
          metric: EMBEDDING_METRIC,
          model: batch.model,
          provider: batch.provider,
        })),
      )
      .onConflictDoUpdate({
        target: [
          juniorMemoryEmbeddings.memoryId,
          juniorMemoryEmbeddings.provider,
          juniorMemoryEmbeddings.model,
        ],
        set: {
          contentHash: sql`excluded.content_hash`,
          createdAtMs: sql`excluded.created_at_ms`,
          dimensions: sql`excluded.dimensions`,
          embedding: sql`excluded.embedding`,
          metric: sql`excluded.metric`,
        },
      });
    embedded += missing.length;
    await args.onBatch?.({ embedded, scanned, ...target });
  }

  return { embedded, scanned, ...target };
}
