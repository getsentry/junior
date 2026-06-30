import type {
  PromptMessage,
  Requester,
  Source,
} from "@sentry/junior-plugin-api";
import {
  createMemoryStore,
  type MemoryDb,
  type MemoryEmbeddingProvider,
  type MemoryRecord,
} from "./store";
import { memoryRuntimeContextSchema } from "./types";

const DEFAULT_RECALL_LIMIT = 5;
const MAX_PROMPT_CHARS = 4_000;
const MAX_MEMORY_LINE_CHARS = 600;

export interface MemoryRecallContext {
  conversationId?: string;
  db: MemoryDb;
  embedder?: MemoryEmbeddingProvider;
  /** Maximum cosine distance for vector recall. Passed through to the memory store. */
  maxVectorDistance?: number;
  requester?: Requester;
  source: Source;
  text: string;
}

function trimContent(content: string, maxLength: number): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatObservedDate(observedAtMs: number): string {
  return new Date(observedAtMs).toISOString().slice(0, 10);
}

function renderMemoryPrompt(memories: MemoryRecord[]): string | undefined {
  const header = "Relevant memories for this request:";
  const footer =
    "Treat these as possibly stale context. Current user instructions and repository evidence take priority.";
  const lines: string[] = [];
  let totalChars = header.length + footer.length + 2;

  for (const memory of memories) {
    const line = `- Observed ${formatObservedDate(memory.observedAtMs)}: ${trimContent(
      memory.content,
      MAX_MEMORY_LINE_CHARS,
    )}`;
    if (totalChars + line.length + 1 > MAX_PROMPT_CHARS) {
      break;
    }
    lines.push(line);
    totalChars += line.length + 1;
  }

  if (lines.length === 0) {
    return undefined;
  }
  return `${header}\n${lines.join("\n")}\n\n${footer}`;
}

/** Build the memory prompt contribution for active visible recall. */
export async function createMemoryPromptMessages(
  context: MemoryRecallContext,
): Promise<PromptMessage[] | undefined> {
  if (!context.text.trim()) {
    return undefined;
  }
  const runtimeContext = memoryRuntimeContextSchema.parse({
    ...(context.conversationId
      ? { conversationId: context.conversationId }
      : {}),
    ...(context.requester ? { requester: context.requester } : {}),
    source: context.source,
  });
  const memories = await createMemoryStore(
    context.db,
    runtimeContext,
    {
      ...(context.embedder ? { embedder: context.embedder } : {}),
      ...(context.maxVectorDistance !== undefined
        ? { maxVectorDistance: context.maxVectorDistance }
        : {}),
    },
  ).searchMemories({
    query: context.text,
    limit: DEFAULT_RECALL_LIMIT,
  });
  const text = renderMemoryPrompt(memories);
  return text ? [{ text }] : undefined;
}
