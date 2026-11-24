/**
 * Backfill of memory vectors for the configured embedding model.
 *
 * The memory heartbeat runs it every minute with a time limit, so a model
 * change backfills itself after deploy, and vectors that a failed or skipped
 * write left out are repaired. It only embeds memories that have no current
 * vector for the model, and `refreshEmbeddings` commits each batch on its own,
 * so it is safe to run again or at the same time.
 */
import { and, asc, eq, gt, isNull, notExists, or, sql } from "drizzle-orm";
import {
  juniorMemoryEmbeddings,
  juniorMemoryMemories,
} from "@/db/schema/memory";
import { refreshEmbeddings } from "@/db/embeddings";
import {
  EMBEDDING_METRIC,
  hashEmbeddedContent,
  type MemoryEmbeddingProvider,
} from "./embedding";
import { MEMORY_EMBEDDING_DIMENSIONS } from "./types";
import { normalizeContent, type MemoryDb } from "./store";

/** Live memories that have no vector of this model for their current content. */
async function listMissingVectors(args: {
  afterId: string | undefined;
  db: MemoryDb;
  embedder: MemoryEmbeddingProvider;
  limit: number;
  nowMs: number;
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
        or(
          isNull(juniorMemoryMemories.expiresAtMs),
          gt(juniorMemoryMemories.expiresAtMs, args.nowMs),
        ),
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
}): Promise<number> {
  const now = args.now ?? Date.now;
  const refresh = await refreshEmbeddings<{
    content: string;
    id: string;
    text: string;
  }>({
    batchSize: args.batchSize,
    deadlineMs: args.deadlineMs,
    dimensions: MEMORY_EMBEDDING_DIMENSIONS,
    embedder: args.embedder,
    now,
    // Paging by id makes sure that each run ends, even if a row stays missing.
    listMissing: async ({ after, limit }) =>
      (
        await listMissingVectors({
          afterId: after?.id,
          db: args.db,
          embedder: args.embedder,
          limit,
          nowMs: now(),
        })
      ).map((memory) => ({
        ...memory,
        text: normalizeContent(memory.content),
      })),
    write: async (rows, batch) => {
      const createdAtMs = now();
      await args.db
        .insert(juniorMemoryEmbeddings)
        .values(
          rows.map(({ item, vector }) => ({
            contentHash: hashEmbeddedContent(item.content),
            createdAtMs,
            dimensions: batch.dimensions,
            embedding: vector,
            memoryId: item.id,
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
    },
  });
  return refresh.embedded;
}
