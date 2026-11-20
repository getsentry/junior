import { useQuery } from "@tanstack/react-query";
import * as z from "zod";

import { fetchDashboardJson } from "../http";
import { conversationSideReadQueryKey } from "./conversationSideReads";
import { markTranscriptRow } from "./useMessageLinkJump";

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
        `/api/memory/conversations/${encodeURIComponent(conversationId)}/memories`,
        signal,
      ),
    queryKey: conversationSideReadQueryKey(conversationId, "memories"),
    retry: false,
  });
}

/** One row of the Conversation memory list. */
export type ConversationMemoryEntry = {
  memory: ConversationMemory;
  /** The recall or capture event, where the transcript opens. */
  seq: number;
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
      entries.push({ memory, seq: event.seq, source: event.source });
    }
  }
  return entries;
}

/**
 * Show the transcript row of a memory event's Turn. The event has no row, so
 * this is the last row before it: the prompt of a recall, or the reply of a
 * capture. Matches `rowIndexBeforeSeq`, which keeps that row mounted.
 */
export function showMemoryRow(root: Element | null, seq: number) {
  // Only the rows of this Conversation's transcript count.
  const transcript = root?.querySelector(
    '[aria-label="Conversation transcript"]',
  );
  let row: Element | undefined;
  let rowSeq: number | undefined;
  // Rows are in seq order. A question moved after its reply keeps the reply
  // seq, so the first row with a seq wins.
  for (const candidate of transcript?.querySelectorAll(
    "[data-transcript-seq]",
  ) ?? []) {
    const candidateSeq = Number(candidate.getAttribute("data-transcript-seq"));
    if (candidateSeq >= seq) break;
    if (candidateSeq === rowSeq) continue;
    row = candidate;
    rowSeq = candidateSeq;
  }
  if (!row) return;
  row.scrollIntoView({ block: "center" });
  markTranscriptRow(row);
}

/** True for the memory plugin event that a Turn's capture emits. */
export function isMemoryCaptureEvent(part: {
  name: string;
  namespace: string;
}): boolean {
  return part.namespace === "memory" && part.name === "memories_captured";
}
