import { getDb } from "@/chat/db";
import { createPluginEmbedder } from "@/chat/plugins/model";
import { memoryDb, searchTypedMemories } from "./store";

// A menu row shows one line of the memory.
const MEMORY_SEARCH_TITLE_CHARS = 120;

/** A memory that matches a search. */
export interface MemorySearchMatch {
  id: string;
  title: string;
}

/**
 * Find the memories that the Memories page shows every User, active public
 * memory only, with the hybrid word and vector search of automatic recall.
 * The vector leg embeds the text once; when that fails, words alone match.
 */
export async function searchPublicMemories(
  text: string,
  limit: number,
): Promise<MemorySearchMatch[]> {
  const memories = await searchTypedMemories({
    db: memoryDb(getDb()),
    embedder: createPluginEmbedder("memory"),
    limit,
    nowMs: Date.now(),
    query: text,
  });
  return memories.map((memory) => ({
    id: memory.id,
    title: memory.content.slice(0, MEMORY_SEARCH_TITLE_CHARS),
  }));
}
