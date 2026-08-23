import { defineConversationEvent } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { MEMORY_KINDS, MEMORY_SCOPES } from "./types";
import type { MemoryRecord } from "./store";

const capturedMemorySchema = z
  .object({
    content: z.string().min(1),
    id: z.string().min(1),
    kind: z.enum(MEMORY_KINDS),
    observedAtMs: z.number().finite(),
    scope: z.enum(MEMORY_SCOPES),
  })
  .strict();

const capturedMemoriesSchema = z
  .object({
    memories: z.array(capturedMemorySchema).max(100),
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();

const recalledMemoriesSchema = z
  .object({
    // Matches the automatic-recall candidate window; admission packs by char budget.
    memories: z.array(z.string().min(1)).max(20),
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();

function renderCapturedMemories(event: z.output<typeof capturedMemoriesSchema>) {
  const count = event.memories.length;
  if (count === 0) return undefined;
  return {
    icon: "brain" as const,
    title: `${count} ${count === 1 ? "memory" : "memories"} captured`,
    details: event.memories.map((memory) => ({
      title: memory.content,
      metadata: [memory.kind, memory.scope],
    })),
  };
}

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
