import { createHash } from "node:crypto";
import type { PluginEmbedder } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { getDb } from "@/chat/db";
import { runBestEffort } from "@/chat/logging";
import { createPluginEmbedder } from "@/chat/plugins/model";
import { getStateAdapter } from "@/chat/state/adapter";
import { usdToMicroUsdUnbiased } from "@/db/micro-usd";
import { addStats } from "@/stats";
import { memoryDb, searchTypedMemories } from "./store";

// A menu row shows one line of the memory.
const MEMORY_SEARCH_TITLE_CHARS = 120;
// Fewer letters have too little meaning to embed. Word matches find them.
const VECTOR_QUERY_MIN_CHARS = 3;
// Long enough for a person to type, delete, and type the same text again.
const QUERY_EMBEDDING_TTL_MS = 10 * 60 * 1000;
const QUERY_EMBEDDING_KEY_PREFIX = "memory-search-embedding:v1";

/** `junior_stats` counter of the embedding spend of typed memory search. */
const EMBEDDING_COST_STAT = {
  metric: "embedding_cost_micro_usd",
  namespace: "search",
} as const;

const cachedEmbeddingSchema = z.object({
  dimensions: z.number().int(),
  model: z.string(),
  provider: z.string(),
  vectors: z.array(z.array(z.number())),
});

/** A memory that matches a search. */
export interface MemorySearchMatch {
  id: string;
  title: string;
}

function queryEmbeddingKey(
  model: string,
  input: Parameters<PluginEmbedder["embedTexts"]>[0],
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([input.inputType ?? "", ...input.texts]))
    .digest("hex");
  return `${QUERY_EMBEDDING_KEY_PREFIX}:${model}:${hash}`;
}

async function recordEmbeddingCost(
  model: string,
  costUsd: number,
): Promise<void> {
  await runBestEffort(
    () =>
      addStats([
        {
          ...EMBEDDING_COST_STAT,
          count: usdToMicroUsdUnbiased(costUsd),
          name: model,
        },
      ]),
    "memory.search.embedding_cost_record_failed",
  );
}

/**
 * Embed typed search text, and reuse the vector of the same text for a few
 * minutes, so a person who types it again makes no model call. A search has
 * no Conversation to bill, so each call adds its cost to a daily
 * `junior_stats` counter. The write runs with the vector query; `settled`
 * waits for it.
 */
function cachedQueryEmbedder(): {
  embedder: PluginEmbedder;
  settled: () => Promise<void>;
} {
  const embedder = createPluginEmbedder("memory");
  const costWrites: Promise<void>[] = [];
  return {
    embedder: {
      model: embedder.model,
      provider: embedder.provider,
      async embedTexts(input) {
        const state = getStateAdapter();
        const key = queryEmbeddingKey(embedder.model, input);
        const cached = cachedEmbeddingSchema.safeParse(await state.get(key));
        if (cached.success) return cached.data;
        const result = await embedder.embedTexts(input);
        const { costUsd, ...embedding } = result;
        if (costUsd !== undefined) {
          costWrites.push(recordEmbeddingCost(embedder.model, costUsd));
        }
        await runBestEffort(
          () => state.set(key, embedding, QUERY_EMBEDDING_TTL_MS),
          "memory.search.embedding_cache_write_failed",
        );
        return result;
      },
    },
    settled: async () => {
      await Promise.all(costWrites);
    },
  };
}

/**
 * Find the memories that the Memories page shows every User, active public
 * memory only, with the hybrid word and vector search of automatic recall.
 * Text of 3 or more characters is embedded once, from a short cache when it
 * was typed recently; when that fails, words alone match.
 */
export async function searchPublicMemories(
  text: string,
  limit: number,
): Promise<MemorySearchMatch[]> {
  const query =
    text.trim().length >= VECTOR_QUERY_MIN_CHARS
      ? cachedQueryEmbedder()
      : undefined;
  const memories = await searchTypedMemories({
    db: memoryDb(getDb()),
    embedder: query?.embedder,
    limit,
    nowMs: Date.now(),
    query: text,
  });
  await query?.settled();
  return memories.map((memory) => ({
    id: memory.id,
    title: memory.content.slice(0, MEMORY_SEARCH_TITLE_CHARS),
  }));
}
