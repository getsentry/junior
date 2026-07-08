import { createHash } from "node:crypto";
import {
  getSourceKey,
  isPrivateSource,
  type PluginRunContext,
  type PluginRunTranscriptEntry,
  type PluginTaskContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  createMemoryStore,
  type CreateMemoryInput,
  type MemoryDb,
} from "./store";
import {
  createMemoryAgent,
  parseExtractedMemory,
  type ExtractedMemory,
} from "./agent";
import { MEMORY_KINDS, memoryRuntimeContextSchema } from "./types";

const MEMORY_TOOL_NAMES = new Set([
  "createMemory",
  "listMemories",
  "removeMemory",
  "searchMemories",
]);
const MEMORY_TASK_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const extractedMemoryCacheSchema = z.array(
  z
    .object({
      content: z.string().min(1),
      expiresAtMs: z.number().finite().nullable(),
      kind: z.enum(MEMORY_KINDS),
      evidenceMessageIndices: z
        .array(z.number().int().nonnegative())
        .min(1)
        .max(10),
    })
    .strict()
    .transform(parseExtractedMemory),
);

/** Where a passively extracted memory may be stored, or dropped when unproven. */
type MemoryRouteTarget = "drop" | "personal" | "conversation";

/** A cited entry is a run-actor durable instruction evidence entry. */
function isRunActorInstruction(entry: PluginRunTranscriptEntry): boolean {
  return (
    entry.type === "message" &&
    entry.role === "user" &&
    entry.provenance?.authority === "instruction" &&
    entry.isRunActor === true
  );
}

/** A cited entry is valid public conversation evidence for shared knowledge. */
function isConversationEvidence(entry: PluginRunTranscriptEntry): boolean {
  if (entry.type === "toolResult") {
    return entry.isError === false && Boolean(entry.text?.trim());
  }
  if (
    entry.type === "message" &&
    entry.role === "user" &&
    entry.provenance?.authority === "instruction" &&
    entry.isRunActor === false
  ) {
    return Boolean(entry.provenance.actor);
  }
  return (
    entry.type === "message" &&
    entry.role === "user" &&
    entry.provenance?.authority === "context"
  );
}

/** Resolve the deduplicated cited transcript entries, failing on bad indices. */
function citedEntries(
  indices: number[],
  transcript: PluginRunTranscriptEntry[],
): { valid: boolean; entries: PluginRunTranscriptEntry[] } {
  const seen = new Set<number>();
  const entries: PluginRunTranscriptEntry[] = [];
  for (const index of indices) {
    if (seen.has(index)) {
      continue;
    }
    seen.add(index);
    const entry = transcript[index];
    if (!entry) {
      return { valid: false, entries: [] };
    }
    entries.push(entry);
  }
  return { valid: entries.length > 0, entries };
}

/**
 * Verify an extracted memory against runtime-owned provenance on its cited
 * evidence. This is a deterministic authority boundary, not a model decision:
 * personal preferences require a single-actor run whose citations are all
 * run-actor instructions, conversation knowledge requires run-actor instruction
 * or valid public conversation evidence, and anything unproven (including
 * missing provenance) is dropped. Multi-actor runs interleave first-person
 * statements from different people, so they never store a preference regardless
 * of citations; a personal preference can wait for a single-actor run.
 */
function routeExtractedMemory(
  memory: ExtractedMemory,
  transcript: PluginRunTranscriptEntry[],
  run: Pick<PluginRunContext, "actor" | "actors">,
): MemoryRouteTarget {
  const cited = citedEntries(memory.evidenceMessageIndices, transcript);
  if (!cited.valid) {
    return "drop";
  }
  if (memory.kind === "preference") {
    // Only a run attributed to exactly one run actor may store a preference; an
    // empty actor set (system runs) fails closed to "drop".
    const exactlyOneRunActor = Boolean(run.actor) && run.actors.length === 1;
    if (!exactlyOneRunActor) {
      return "drop";
    }
    // Never downgrade an unproven first-person preference to conversation scope.
    return cited.entries.every(isRunActorInstruction) ? "personal" : "drop";
  }
  return cited.entries.every(
    (entry) => isRunActorInstruction(entry) || isConversationEvidence(entry),
  )
    ? "conversation"
    : "drop";
}

function memoryIdempotencySuffix(
  memory: ExtractedMemory,
  target: MemoryRouteTarget,
): string {
  return createHash("sha256")
    .update(target)
    .update("\0")
    .update(memory.kind)
    .update("\0")
    .update(memory.content)
    .update("\0")
    .update(memory.expiresAtMs === null ? "never" : String(memory.expiresAtMs))
    .digest("hex")
    .slice(0, 32);
}

function passiveInput(
  sessionId: string,
  memory: ExtractedMemory,
  sourceKey: string,
  target: MemoryRouteTarget,
): CreateMemoryInput {
  return {
    content: memory.content,
    idempotencyKey: `session:${sourceKey}:${sessionId}:${memoryIdempotencySuffix(memory, target)}`,
    kind: memory.kind,
    ...(memory.expiresAtMs !== null ? { expiresAtMs: memory.expiresAtMs } : {}),
  };
}

async function getTaskMemories(
  context: PluginTaskContext,
  extract: () => Promise<ExtractedMemory[]>,
): Promise<ExtractedMemory[]> {
  const cacheKey = `memory-extraction:${context.id}`;
  const cached = await context.state.get(cacheKey);
  if (cached !== undefined) {
    const parsed = extractedMemoryCacheSchema.safeParse(cached);
    if (parsed.success) {
      return parsed.data;
    }
    await context.state.delete(cacheKey);
  }
  const memories = await extract();
  if (memories.length > 0) {
    await context.state.set(cacheKey, memories, MEMORY_TASK_STATE_TTL_MS);
  }
  return memories;
}

/**
 * Extract and store memories from a completed session plugin task.
 *
 * Memory owns post-session extraction and consumes only the bounded plugin task
 * projection. Explicit memory tools and private non-local sources remain hard
 * boundaries so background retries cannot reinterpret user-directed mutations
 * or private conversations.
 */
export async function processMemorySession(
  context: PluginTaskContext,
): Promise<void> {
  const run = await context.run.load();
  // Memory tool turns already own memory management or recall; do not reinterpret
  // recalled memory output as fresh passive-learning evidence.
  if (
    run.transcript.some(
      (entry) =>
        entry.type === "toolResult" && MEMORY_TOOL_NAMES.has(entry.toolName),
    )
  ) {
    return;
  }
  // V1 passive learning only stores public channel facts outside local QA.
  if (run.source.platform !== "local" && isPrivateSource(run.source)) {
    return;
  }
  const sourceKey = getSourceKey(run.source);
  if (!sourceKey) {
    return;
  }
  const transcript = run.transcript
    .filter((entry) => entry.text?.trim())
    .map((entry) => ({ ...entry, text: entry.text!.trim() }));
  const evidenceText = transcript
    .filter((entry) => entry.type === "toolResult" || entry.role === "user")
    .map((entry) => entry.text)
    .join("\n\n")
    .trim();
  if (!evidenceText) {
    return;
  }

  const runtimeContext = memoryRuntimeContextSchema.parse({
    conversationId: run.conversationId,
    ...(run.actor ? { actor: run.actor } : {}),
    source: run.source,
  });
  const agent = createMemoryAgent(context.model);
  const store = createMemoryStore(context.db as MemoryDb, runtimeContext, {
    embedder: context.embedder,
    supersessionDecider: agent,
  });
  await store.archiveExpiredMemories();
  const memories = await getTaskMemories(context, async () => {
    const existingMemories = await store.searchMemories({
      limit: 10,
      query: evidenceText,
    });
    return await agent.extractSessionMemories({
      existingMemories: existingMemories.map((memory) => ({
        content: memory.content,
      })),
      actors: run.actors,
      transcript,
      runtimeContext,
    });
  });
  if (memories.length === 0) {
    return;
  }

  for (const memory of memories) {
    // The routing gate stays even though extraction is also actor-gated:
    // getTaskMemories caches extraction output for 7 days, so a retry can replay
    // preference proposals cached before this gate existed.
    const target = routeExtractedMemory(memory, transcript, run);
    if (target === "drop") {
      continue;
    }
    const input = passiveInput(run.runId, memory, sourceKey, target);
    if (target === "conversation") {
      await store.createConversationMemory(input);
      continue;
    }
    await store.createMemory(input);
  }
}
