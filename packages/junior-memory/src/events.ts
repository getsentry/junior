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

/** Durable transcript event emitted after background memory capture. */
export const memoriesCapturedEvent = defineConversationEvent({
  name: "memories_captured",
  version: 1,
  schema: z
    .object({
      memories: z.array(capturedMemorySchema).min(1).max(100),
    })
    .strict(),
  renderEvent(event) {
    const count = event.memories.length;
    return {
      icon: "brain",
      title: count === 1 ? "Memory captured" : "Memories captured",
      preview: count === 1 ? event.memories[0]!.content : `${count} memories`,
      details: event.memories.map((memory) => ({
        title: memory.content,
        metadata: [memory.kind, memory.scope],
      })),
    };
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
