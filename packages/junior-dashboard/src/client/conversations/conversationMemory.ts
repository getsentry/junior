import { useQuery } from "@tanstack/react-query";
import * as z from "zod";

import { fetchDashboardJson } from "../http";
import { conversationSideReadQueryKey } from "./conversationSideReads";

const conversationMemoryListSchema = z
  .object({
    events: z.array(
      z
        .object({
          memoryIds: z.array(z.string().min(1)).min(1),
          seq: z.number().int().min(0),
          source: z.enum(["captured", "recalled"]),
          turnId: z.string().min(1).optional(),
        })
        .strict(),
    ),
    memories: z.array(
      z
        .object({
          content: z.string().min(1),
          id: z.string().min(1),
          visibility: z.enum(["private", "public"]),
        })
        .strict(),
    ),
  })
  .strict();

export type ConversationMemoryList = z.output<
  typeof conversationMemoryListSchema
>;
type ConversationMemory = ConversationMemoryList["memories"][number];
type MemorySource = ConversationMemoryList["events"][number]["source"];

/** Load what one Conversation recalled and captured. */
export function useConversationMemories(conversationId: string) {
  return useQuery({
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationMemoryListSchema,
        `/api/plugins/memory/conversations/${encodeURIComponent(conversationId)}/memories`,
        signal,
      ),
    queryKey: conversationSideReadQueryKey(conversationId, "memories"),
    retry: false,
  });
}

/** One row of the Conversation memory list. */
export type ConversationMemoryEntry = {
  memory: ConversationMemory;
  source: MemorySource;
};

/**
 * Flatten recalls and captures into one list in Conversation order. A memory
 * shows once per source, at the first Turn that recalled or captured it.
 */
export function conversationMemoryEntries(
  list: ConversationMemoryList | undefined,
): ConversationMemoryEntry[] {
  if (!list) return [];
  const byId = new Map(list.memories.map((memory) => [memory.id, memory]));
  const seen = new Set<string>();
  const entries: ConversationMemoryEntry[] = [];
  for (const event of list.events) {
    for (const id of event.memoryIds) {
      const key = `${event.source}:${id}`;
      const memory = byId.get(id);
      if (seen.has(key) || !memory) continue;
      seen.add(key);
      entries.push({ memory, source: event.source });
    }
  }
  return entries;
}

/** True for the memory plugin event that a Turn's capture emits. */
export function isMemoryCaptureEvent(part: {
  name: string;
  namespace: string;
}): boolean {
  return part.namespace === "memory" && part.name === "memories_captured";
}
