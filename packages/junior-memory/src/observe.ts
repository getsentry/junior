import {
  getSourceKey,
  isPrivateSource,
  type TurnObservationContext,
} from "@sentry/junior-plugin-api";
import {
  createMemoryStore,
  type CreateMemoryInput,
  type MemoryDb,
} from "./store";
import {
  createMemoryAgent,
  type ExtractedMemory,
  type MemoryAgentOptions,
} from "./agent";
import { memoryRuntimeContextSchema } from "./types";

const MEMORY_TOOL_NAMES = new Set([
  "createMemory",
  "listMemories",
  "removeMemory",
  "searchMemories",
]);

function passiveInput(
  context: TurnObservationContext,
  memory: ExtractedMemory,
  index: number,
  sourceKey: string,
): CreateMemoryInput {
  return {
    content: memory.content,
    idempotencyKey: `observe:${sourceKey}:${context.turnId}:${index}`,
    ...(memory.expiresAtMs !== null ? { expiresAtMs: memory.expiresAtMs } : {}),
  };
}

/** Extract and store memories from a delivered turn without using model-visible tools. */
export async function observeMemoryTurn(
  context: TurnObservationContext,
  options: MemoryAgentOptions = {},
): Promise<void> {
  if (context.toolCalls.some((toolName) => MEMORY_TOOL_NAMES.has(toolName))) {
    return;
  }
  if (context.source.platform !== "local" && isPrivateSource(context.source)) {
    return;
  }
  const sourceKey = getSourceKey(context.source);
  if (!sourceKey) {
    return;
  }
  const userText = context.userText.trim();
  if (!userText) {
    return;
  }

  const runtimeContext = memoryRuntimeContextSchema.parse({
    ...(context.conversationId
      ? { conversationId: context.conversationId }
      : {}),
    ...(context.requester ? { requester: context.requester } : {}),
    source: context.source,
  });
  const store = createMemoryStore(context.db as MemoryDb, runtimeContext, {
    embedder: context.embedder,
  });
  const existingMemories = await store.searchMemories({
    limit: 10,
    query: userText,
  });
  const agent = createMemoryAgent(context.model, options);
  const memories = await agent.extractTurnMemories({
    assistantText: context.assistantText,
    existingMemories: existingMemories.map((memory) => ({
      content: memory.content,
    })),
    runtimeContext,
    userText,
  });
  if (memories.length === 0) {
    return;
  }

  for (const [index, memory] of memories.entries()) {
    const input = passiveInput(context, memory, index, sourceKey);
    if (memory.target === "conversation") {
      await store.createConversationMemory(input);
      continue;
    }
    await store.createMemory(input);
  }
}
