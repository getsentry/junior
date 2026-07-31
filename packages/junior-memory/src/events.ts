import { defineConversationEvent } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { MEMORY_KINDS, MEMORY_SCOPES } from "./types";
import type { MemoryRecord } from "./store";

const MAX_EVENT_PREVIEW_CHARS = 500;

const capturedMemorySchema = z
  .object({
    content: z.string().min(1),
    id: z.string().min(1),
    kind: z.enum(MEMORY_KINDS),
    observedAtMs: z.number().finite(),
    scope: z.enum(MEMORY_SCOPES),
  })
  .strict();

function eventPreview(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_EVENT_PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_EVENT_PREVIEW_CHARS - 3).trimEnd()}...`;
}

const capturedMemoriesSchema = z
  .object({
    memories: z.array(capturedMemorySchema).max(100),
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();

const recalledMemoriesSchema = z
  .object({
    memories: z.array(z.string().min(1)).max(5),
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();

function renderCapturedMemories(
  event: z.output<typeof capturedMemoriesSchema>,
) {
  const count = event.memories.length;
  if (count === 0) return undefined;
  return {
    icon: "brain" as const,
    title: count === 1 ? "Memory captured" : "Memories captured",
    preview:
      count === 1
        ? eventPreview(event.memories[0]!.content)
        : `${count} memories`,
    details: event.memories.map((memory) => ({
      title: memory.content,
      metadata: [memory.kind, memory.scope],
    })),
  };
}

/** Previous stored memory-capture event shape retained for transcript rendering. */
export const memoriesCapturedEventV1 = defineConversationEvent({
  name: "memories_captured",
  version: 1,
  schema: z
    .object({
      memories: z.array(capturedMemorySchema).min(1).max(100),
    })
    .strict(),
  renderEvent: renderCapturedMemories,
});

/** Durable outcome emitted after every completed passive memory extraction. */
export const memoriesCapturedEvent = defineConversationEvent({
  name: "memories_captured",
  version: 2,
  schema: capturedMemoriesSchema,
  renderEvent: renderCapturedMemories,
});

/** Durable outcome emitted after one completed automatic recall attempt. */
export const memoriesRecalledEvent = defineConversationEvent({
  name: "memories_recalled",
  version: 1,
  schema: recalledMemoriesSchema,
  renderEvent() {
    return undefined;
  },
});

/** Select the stable, safe memory fields retained in conversation history. */
export function capturedMemory(memory: MemoryRecord) {
  return {
    content: memory.content,
    id: memory.id,
    kind: memory.kind,
    observedAtMs: memory.observedAtMs,
    scope: memory.scope,
  };
}
