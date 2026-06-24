import {
  getSourceKey,
  isPrivateSource,
  type PluginTaskContext,
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

const MEMORY_MUTATION_TOOL_NAMES = new Set(["createMemory", "removeMemory"]);

function passiveInput(
  sessionId: string,
  memory: ExtractedMemory,
  index: number,
  sourceKey: string,
): CreateMemoryInput {
  return {
    content: memory.content,
    idempotencyKey: `session:${sourceKey}:${sessionId}:${index}`,
    ...(memory.expiresAtMs !== null ? { expiresAtMs: memory.expiresAtMs } : {}),
  };
}

/** Extract and store memories from a completed session plugin task. */
export async function processMemorySession(
  context: PluginTaskContext,
  options: MemoryAgentOptions = {},
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
  const existingMemories = await store.searchMemories({
    limit: 10,
    query: userText,
  });
  const agent = createMemoryAgent(context.model, options);
  const memories = await agent.extractSessionMemories({
    existingMemories: existingMemories.map((memory) => ({
      content: memory.content,
    })),
    messages,
    runtimeContext,
  });
  if (memories.length === 0) {
    return;
  }

  for (const [index, memory] of memories.entries()) {
    const input = passiveInput(session.sessionId, memory, index, sourceKey);
    if (memory.target === "conversation") {
      await store.createConversationMemory(input);
      continue;
    }
    await store.createMemory(input);
  }
}
