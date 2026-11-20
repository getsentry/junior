import { defineConversationEvent } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { RETIRE_REASONS, type RetireReason } from "./lifecycle";
import { MEMORY_KINDS, MEMORY_SCOPES } from "./types";
import type { MemoryRecord } from "./store";

const capturedMemoryFields = {
  content: z.string().min(1),
  id: z.string().min(1),
  kind: z.enum(MEMORY_KINDS),
  observedAtMs: z.number().finite(),
};

const legacyCapturedMemorySchema = z
  .object({
    ...capturedMemoryFields,
    scope: z.enum(["personal", "conversation"]),
  })
  .strict();

const capturedMemorySchema = z
  .object({
    ...capturedMemoryFields,
    scope: z.enum(MEMORY_SCOPES),
  })
  .strict();

const legacyCapturedMemoriesSchema = z
  .object({
    memories: z.array(legacyCapturedMemorySchema).min(1).max(100),
  })
  .strict();

const capturedMemoriesSchema = z
  .object({
    memories: z.array(capturedMemorySchema).max(100),
    // Only events stored before Junior recorded plugin model cost have it.
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();

const archivedMemorySchema = z
  .object({
    ...capturedMemoryFields,
    reason: z.enum(RETIRE_REASONS),
    scope: z.enum(MEMORY_SCOPES),
    /** Memory captured in the same Turn that states the current fact. */
    supersededById: z.string().min(1).optional(),
  })
  .strict();

const capturedMemoriesV3Schema = z
  .object({
    /** Memories that this Turn's evidence retired. */
    archived: z.array(archivedMemorySchema).max(100),
    memories: z.array(capturedMemorySchema).max(100),
  })
  .strict();

const recalledMemoriesSchema = z
  .object({
    // Matches the automatic-recall candidate window; admission packs by char budget.
    memories: z.array(z.string().min(1)).max(20),
    // Only events stored before Junior recorded plugin model cost have it.
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();

function currentScope(
  scope: "personal" | "conversation" | "private" | "public",
) {
  if (scope === "personal") return "private";
  if (scope === "conversation") return "public";
  return scope;
}

function memoryCount(count: number): string {
  return `${count} ${count === 1 ? "memory" : "memories"}`;
}

function renderCapturedMemories(event: {
  archived?: Array<z.output<typeof archivedMemorySchema>>;
  memories: Array<
    | z.output<typeof legacyCapturedMemorySchema>
    | z.output<typeof capturedMemorySchema>
  >;
}) {
  const count = event.memories.length;
  const archived = event.archived ?? [];
  if (count === 0 && archived.length === 0) return undefined;
  const title =
    archived.length === 0
      ? `Captured ${memoryCount(count)}`
      : count === 0
        ? `Archived ${memoryCount(archived.length)}`
        : `Captured ${memoryCount(count)}, archived ${archived.length}`;
  return {
    icon: "brain" as const,
    title,
    details: [
      ...event.memories.map((memory) => ({
        title: memory.content,
        metadata: [memory.kind, currentScope(memory.scope)],
      })),
      ...archived.map((memory) => ({
        title: memory.content,
        metadata: [memory.kind, memory.reason],
      })),
    ],
  };
}

/** Previous stored memory-capture event shape retained for transcript rendering. */
export const memoriesCapturedEventV1 = defineConversationEvent({
  name: "memories_captured",
  version: 1,
  schema: legacyCapturedMemoriesSchema,
  renderEvent: renderCapturedMemories,
});

/** Previous stored memory-capture event shape retained for transcript rendering. */
export const memoriesCapturedEventV2 = defineConversationEvent({
  name: "memories_captured",
  version: 2,
  schema: capturedMemoriesSchema,
  renderEvent: renderCapturedMemories,
});

/**
 * Durable outcome emitted after every completed passive memory extraction:
 * the memories it captured and the ones that its evidence retired. The event
 * lives in the evidence Conversation and Turn, so it is the audit trail.
 */
export const memoriesCapturedEvent = defineConversationEvent({
  name: "memories_captured",
  version: 3,
  schema: capturedMemoriesV3Schema,
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

type CapturedMemory =
  | z.output<typeof legacyCapturedMemorySchema>
  | z.output<typeof capturedMemorySchema>;

/** Parse one supported stored memory-capture event. */
export function parseCapturedMemories(
  version: number,
  content: unknown,
): CapturedMemory[] {
  if (version === memoriesCapturedEventV1.version) {
    return legacyCapturedMemoriesSchema.parse(content).memories;
  }
  if (version === memoriesCapturedEventV2.version) {
    return capturedMemoriesSchema.parse(content).memories;
  }
  if (version === memoriesCapturedEvent.version) {
    return capturedMemoriesV3Schema.parse(content).memories;
  }
  return [];
}

/** Parse the memory ids from one supported stored recall event. */
export function parseRecalledMemoryIds(
  version: number,
  content: unknown,
): string[] {
  if (version === memoriesRecalledEvent.version) {
    return recalledMemoriesSchema.parse(content).memories;
  }
  return [];
}

/** Select the retained fields of a memory that automatic retirement archived. */
export function archivedMemory(memory: MemoryRecord, reason: RetireReason) {
  return {
    ...capturedMemory(memory),
    reason,
    ...(memory.supersededById
      ? { supersededById: memory.supersededById }
      : undefined),
  };
}

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
