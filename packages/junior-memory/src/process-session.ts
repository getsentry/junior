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
import { createMemoryAgent, type ExtractedMemory } from "./agent";
import { memoryRuntimeContextSchema } from "./types";

const MEMORY_MUTATION_TOOL_NAMES = new Set(["createMemory", "removeMemory"]);
const MEMORY_TASK_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const extractedMemoryCacheSchema = z.array(
  z
    .object({
      content: z.string().min(1),
      expiresAtMs: z.number().finite().nullable(),
      target: z.enum(["requester", "conversation"]),
    })
    .strict(),
);

function memoryIdempotencySuffix(memory: ExtractedMemory): string {
  return createHash("sha256")
    .update(memory.target)
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
  await context.state.set(cacheKey, memories, MEMORY_TASK_STATE_TTL_MS);
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
  const session = await context.session.load();
  // Explicit memory mutation tools already own the user's memory-management intent.
  if (
    session.toolCalls.some((toolName) =>
      MEMORY_MUTATION_TOOL_NAMES.has(toolName),
    )
  ) {
    return;
  }
  // V1 passive learning only stores public channel facts outside local QA.
  if (session.source.platform !== "local" && isPrivateSource(session.source)) {
    return;
  }
  const sourceKey = getSourceKey(session.source);
  if (!sourceKey) {
    return;
  }
  const messages = session.messages
    .filter((message) => message.text.trim())
    .map((message) => ({ role: message.role, text: message.text.trim() }));
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => message.text)
    .join("\n\n")
    .trim();
  if (!userText) {
    return;
  }

  const runtimeContext = memoryRuntimeContextSchema.parse({
    conversationId: session.conversationId,
    ...(session.requester ? { requester: session.requester } : {}),
    source: session.source,
  });
  const store = createMemoryStore(context.db as MemoryDb, runtimeContext, {
    embedder: context.embedder,
  });
  const memories = await getTaskMemories(context, async () => {
    const existingMemories = await store.searchMemories({
      limit: 10,
      query: userText,
    });
    const agent = createMemoryAgent(context.model);
    return await agent.extractSessionMemories({
      existingMemories: existingMemories.map((memory) => ({
        content: memory.content,
      })),
      messages,
      runtimeContext,
    });
  });
  if (memories.length === 0) {
    return;
  }

  for (const memory of memories) {
    const input = passiveInput(session.sessionId, memory, sourceKey);
    if (memory.target === "conversation") {
      await store.createConversationMemory(input);
      continue;
    }
    await store.createMemory(input);
  }
}
