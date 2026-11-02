/**
 * Backfill of memory vectors for the configured embedding model.
 *
 * The memory heartbeat runs it every minute with a time limit, so a model
 * change backfills itself after deploy, and vectors that a failed or skipped
 * write left out are repaired. The `reembed` CLI command runs it to the end.
 * It only embeds memories that have no current vector for the model, and it
 * commits each batch on its own, so it is safe to run again or at the same time.
 */
import { and, asc, eq, gt, isNull, notExists, sql } from "drizzle-orm";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import {
  EMBEDDING_METRIC,
  hashEmbeddedContent,
  parseEmbeddingBatch,
  type MemoryEmbeddingProvider,
} from "./embedding";
import { normalizeContent, type MemoryDb } from "./store";

/** Live memories that have no vector of this model for their current content. */
async function listMissingVectors(args: {
  afterId: string | undefined;
  db: MemoryDb;
  embedder: MemoryEmbeddingProvider;
  limit: number;
}): Promise<Array<{ content: string; id: string }>> {
  // Same hash as hashEmbeddedContent(): sha256 hex of the UTF-8 content.
  const currentVector = args.db
    .select({ one: sql`1` })
    .from(juniorMemoryEmbeddings)
    .where(
      and(
        eq(juniorMemoryEmbeddings.memoryId, juniorMemoryMemories.id),
        eq(juniorMemoryEmbeddings.provider, args.embedder.provider),
        eq(juniorMemoryEmbeddings.model, args.embedder.model),
        eq(
          juniorMemoryEmbeddings.contentHash,
          sql`encode(sha256(convert_to(${juniorMemoryMemories.content}, 'UTF8')), 'hex')`,
        ),
      ),
    );
  return await args.db
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
        args.afterId === undefined
          ? undefined
          : gt(juniorMemoryMemories.id, args.afterId),
        notExists(currentVector),
      ),
    )
    .orderBy(asc(juniorMemoryMemories.id))
    .limit(args.limit);
}

/** Embed live memories that have no current vector for the embedder's model; return the count. */
export async function reembedMemories(args: {
  batchSize: number;
  db: MemoryDb;
  /** Do not start a new batch at or after this time. */
  deadlineMs?: number;
  embedder: MemoryEmbeddingProvider;
  now?: () => number;
  onBatch?: (embedded: number) => Promise<void> | void;
}): Promise<number> {
  const now = args.now ?? Date.now;
  // Paging by id makes sure that each run ends, even if a row stays missing.
  let afterId: string | undefined;
  let embedded = 0;

  for (;;) {
    if (args.deadlineMs !== undefined && now() >= args.deadlineMs) {
      return embedded;
    }
    const missing = await listMissingVectors({
      afterId,
      db: args.db,
      embedder: args.embedder,
      limit: args.batchSize,
    });
    const last = missing.at(-1);
    if (!last) {
      return embedded;
    }
    afterId = last.id;

    const batch = parseEmbeddingBatch(
      await args.embedder.embedTexts({
        inputType: "document",
        texts: missing.map((memory) => normalizeContent(memory.content)),
      }),
      missing.length,
    );
    if (
      batch.provider !== args.embedder.provider ||
      batch.model !== args.embedder.model
    ) {
      throw new Error("The embedder returned vectors of a different model.");
    }

    const createdAtMs = now();
    await args.db
      .insert(juniorMemoryEmbeddings)
      .values(
        missing.map((memory, index) => ({
          contentHash: hashEmbeddedContent(memory.content),
          createdAtMs,
          dimensions: batch.dimensions,
          embedding: batch.vectors[index]!,
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
    await args.onBatch?.(embedded);
  }
}
