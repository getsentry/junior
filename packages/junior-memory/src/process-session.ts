import { createHash } from "node:crypto";
import {
  getSourceKey,
  isPrivateSource,
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
import {
  MEMORY_KINDS,
  memoryRuntimeContextSchema,
  type MemoryKind,
} from "./types";

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
    })
    .strict()
    .transform(parseExtractedMemory),
);

function targetForKind(kind: MemoryKind): "actor" | "conversation" {
  if (kind === "preference") {
    return "actor";
  }
  return "conversation";
}

function memoryIdempotencySuffix(memory: ExtractedMemory): string {
  return createHash("sha256")
    .update(targetForKind(memory.kind))
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
): CreateMemoryInput {
  return {
    content: memory.content,
    idempotencyKey: `session:${sourceKey}:${sessionId}:${memoryIdempotencySuffix(memory)}`,
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
    return extractedMemoryCacheSchema.parse(cached);
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
      transcript,
      runtimeContext,
    });
  });
  if (memories.length === 0) {
    return;
  }

  for (const memory of memories) {
    const input = passiveInput(run.runId, memory, sourceKey);
    if (targetForKind(memory.kind) === "conversation") {
      await store.createConversationMemory(input);
      continue;
    }
    if (!run.actor) {
      continue;
    }
    await store.createMemory(input);
  }
}
