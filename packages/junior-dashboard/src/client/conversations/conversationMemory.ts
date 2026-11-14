import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
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
export type ConversationMemory = ConversationMemoryList["memories"][number];
type MemorySource = ConversationMemoryList["events"][number]["source"];

/** One transcript spot that recalled or captured memories. */
export type MemoryAnchor = { source: MemorySource; turnId: string };

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

/** Name the transcript element that opens one anchor's popover. */
export function memoryAnchorKey(anchor: MemoryAnchor): string {
  return `${anchor.source}:${anchor.turnId}`;
}

/** List the memories that one transcript spot recalled or captured. */
export function anchorMemories(
  list: ConversationMemoryList | undefined,
  anchor: MemoryAnchor,
): ConversationMemory[] {
  const event = list?.events.find(
    (candidate) =>
      candidate.source === anchor.source && candidate.turnId === anchor.turnId,
  );
  if (!event || !list) return [];
  const byId = new Map(list.memories.map((memory) => [memory.id, memory]));
  return event.memoryIds.flatMap((id) => {
    const memory = byId.get(id);
    return memory ? [memory] : [];
  });
}

/** One row of the Conversation memory list. */
export type ConversationMemoryEntry = {
  memory: ConversationMemory;
  /** The recall or capture event, where the transcript opens. */
  seq: number;
  source: MemorySource;
  turnId?: string;
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
      entries.push({
        memory,
        seq: event.seq,
        source: event.source,
        ...(event.turnId ? { turnId: event.turnId } : undefined),
      });
    }
  }
  return entries;
}

/** The open memory popover, and the memory it highlights. */
export type OpenMemoryPopover = MemoryAnchor & { memoryId?: string };

/** A memory chosen in details, and the event where the transcript opens. */
export type MemoryJump = OpenMemoryPopover & { seq: number };

/** Shared memory popover state for one Conversation page. */
export type ConversationMemoryState = {
  list?: ConversationMemoryList | undefined;
  open?: OpenMemoryPopover | undefined;
  setOpen(open: OpenMemoryPopover | undefined): void;
};

/**
 * Let the transcript and the details panel share memory popovers. Only the
 * Conversation page sets it, so nested transcripts show plain events.
 */
export const ConversationMemoryContext = createContext<
  ConversationMemoryState | undefined
>(undefined);

/** Read the memory popover state of the current Conversation page. */
export function useConversationMemoryState() {
  return useContext(ConversationMemoryContext);
}

/** True for the memory plugin event that a Turn's capture emits. */
export function isMemoryCaptureEvent(part: {
  name: string;
  namespace: string;
}): boolean {
  return part.namespace === "memory" && part.name === "memories_captured";
}
