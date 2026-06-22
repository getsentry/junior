import type { TurnObservationContext } from "@sentry/junior-plugin-api";
import {
  createMemoryStore,
  type CreateMemoryInput,
  type MemoryDb,
} from "./store";
import { createMemoryAgent, type ExtractedMemory } from "./agent";
import { memoryRuntimeContextSchema } from "./types";

const MEMORY_TOOL_NAMES = new Set([
  "createMemory",
  "listMemories",
  "removeMemory",
  "searchMemories",
]);

function canPassivelyLearn(context: TurnObservationContext): boolean {
  if (context.source.platform === "local") {
    return true;
  }
  return Boolean(
    context.source.channelId.startsWith("C") &&
    (context.source.threadTs ?? context.source.messageTs),
  );
}

function observationSourceKey(context: TurnObservationContext): string {
  if (context.source.platform === "local") {
    return context.source.conversationId;
  }
  const messageKey = context.source.threadTs ?? context.source.messageTs;
  return `slack:${context.source.teamId}:${context.source.channelId}:${messageKey}`;
}

function passiveInput(
  context: TurnObservationContext,
  memory: ExtractedMemory,
  index: number,
): CreateMemoryInput {
  return {
    content: memory.content,
    idempotencyKey: `observe:${observationSourceKey(context)}:${context.turnId}:${index}`,
    ...(memory.expiresAtMs !== null ? { expiresAtMs: memory.expiresAtMs } : {}),
  };
}

/** Extract and store memories from a delivered turn without using model-visible tools. */
export async function observeMemoryTurn(
  context: TurnObservationContext,
): Promise<void> {
  if (context.toolCalls.some((toolName) => MEMORY_TOOL_NAMES.has(toolName))) {
    return;
  }
  if (!canPassivelyLearn(context)) {
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
  const agent = createMemoryAgent(context.model);
  const memories = await agent.extractTurnMemories({
    runtimeContext,
    userText,
  });
  if (memories.length === 0) {
    return;
  }

  const store = createMemoryStore(context.db as MemoryDb, runtimeContext, {
    embedder: context.embedder,
  });
  for (const [index, memory] of memories.entries()) {
    const input = passiveInput(context, memory, index);
    if (memory.target === "conversation") {
      await store.createConversationMemory(input);
      continue;
    }
    await store.createMemory(input);
  }
}
