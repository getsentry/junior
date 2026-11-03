import { defineConversationEvent } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { MEMORY_KINDS, MEMORY_SCOPES, RECALL_CANDIDATE_LIMIT } from "./types";
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
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();

const recalledMemoryIdsSchema = z
  .array(z.string().min(1))
  .max(RECALL_CANDIDATE_LIMIT);

const legacyRecalledMemoriesSchema = z
  .object({
    memories: recalledMemoryIdsSchema,
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();

// Ids and retrieval numbers only. Memory content stays out of history.
const recallCandidateFields = {
  id: z.string().min(1),
  lexicalRank: z.number().int().positive().optional(),
  rank: z.number().int().positive(),
  scope: z.enum(MEMORY_SCOPES),
  vectorDistance: z.number().finite().optional(),
};

const recalledMemoriesSchema = z.union([
  z
    .object({
      candidates: z
        .array(
          z
            .object({ ...recallCandidateFields, selected: z.boolean() })
            .strict(),
        )
        .max(RECALL_CANDIDATE_LIMIT),
      costUsd: z.number().finite().nonnegative().optional(),
      // Selected candidates that fit the prompt budget.
      memories: recalledMemoryIdsSchema,
    })
    .strict(),
  z
    .object({
      // No `selected` flag: a failed selection is not a choice of none.
      candidates: z
        .array(z.object(recallCandidateFields).strict())
        .min(1)
        .max(RECALL_CANDIDATE_LIMIT),
      costUsd: z.number().finite().nonnegative().optional(),
      memories: z.array(z.string()).length(0),
      selectionFailed: z.literal(true),
    })
    .strict(),
]);

function currentScope(
  scope: "personal" | "conversation" | "private" | "public",
) {
  if (scope === "personal") return "private";
  if (scope === "conversation") return "public";
  return scope;
}

function renderCapturedMemories(event: {
  memories: Array<
    | z.output<typeof legacyCapturedMemorySchema>
    | z.output<typeof capturedMemorySchema>
  >;
}) {
  const count = event.memories.length;
  if (count === 0) return undefined;
  return {
    icon: "brain" as const,
    title: `${count} ${count === 1 ? "memory" : "memories"} captured`,
    details: event.memories.map((memory) => ({
      title: memory.content,
      metadata: [memory.kind, currentScope(memory.scope)],
    })),
  };
}

/** Previous stored memory-capture event shape retained for transcript rendering. */
export const memoriesCapturedEventV1 = defineConversationEvent({
  name: "memories_captured",
  version: 1,
  schema: legacyCapturedMemoriesSchema,
  renderEvent: renderCapturedMemories,
});

/** Durable outcome emitted after every completed passive memory extraction. */
export const memoriesCapturedEvent = defineConversationEvent({
  name: "memories_captured",
  version: 2,
  schema: capturedMemoriesSchema,
  renderEvent: renderCapturedMemories,
});

/** Previous stored automatic-recall event shape without candidates. */
export const memoriesRecalledEventV1 = defineConversationEvent({
  name: "memories_recalled",
  version: 1,
  schema: legacyRecalledMemoriesSchema,
  renderEvent() {
    return undefined;
  },
});

/** Durable outcome emitted after one completed automatic recall attempt. */
export const memoriesRecalledEvent = defineConversationEvent({
  name: "memories_recalled",
  version: 2,
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
  if (version === memoriesCapturedEvent.version) {
    return capturedMemoriesSchema.parse(content).memories;
  }
  return [];
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
