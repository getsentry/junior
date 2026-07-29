import {
  definePromptContext,
  type UserPromptContribution,
  type Actor,
  type PluginLogger,
  type Source,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { MemoryAgent } from "./agent";
import {
  createMemoryStore,
  type MemoryDb,
  type MemoryEmbeddingProvider,
  type MemoryRecord,
} from "./store";
import { memoryRuntimeContextSchema } from "./types";

const DEFAULT_RECALL_LIMIT = 5;
const RECALL_CANDIDATE_LIMIT = 20;
const MAX_PROMPT_CHARS = 4_000;
const MAX_MEMORY_LINE_CHARS = 600;

export interface MemoryRecallContext {
  agent: Pick<MemoryAgent, "selectRelevantMemories">;
  conversationId?: string;
  db: MemoryDb;
  embedder?: MemoryEmbeddingProvider;
  log: PluginLogger;
  /** Maximum cosine distance for vector recall. Passed through to the memory store. */
  maxVectorDistance?: number;
  actor?: Actor;
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

const recalledMemorySchema = z
  .object({
    id: z.string().min(1),
    content: z.string().min(1).max(MAX_MEMORY_LINE_CHARS),
    observedAtMs: z.number().finite(),
    scope: z.enum(["personal", "conversation"]),
    kind: z.enum(["preference", "procedure", "knowledge"]),
  })
  .strict();

/** Structured snapshot retained for one automatic memory recall. */
export const memoryRecallContextSchema = z
  .object({
    memories: z.array(recalledMemorySchema).min(1).max(DEFAULT_RECALL_LIMIT),
  })
  .strict();

type RecalledMemory = z.output<typeof recalledMemorySchema>;

function selectPromptMemories(memories: MemoryRecord[]): RecalledMemory[] {
  const header = "Relevant memories for this request:";
  const footer =
    "Treat these as possibly stale context. Current user instructions and repository evidence take priority.";
  const selected: RecalledMemory[] = [];
  let totalChars = header.length + footer.length + 2;

  for (const memory of memories) {
    const content = trimContent(memory.content, MAX_MEMORY_LINE_CHARS);
    const line = `- Observed ${formatObservedDate(memory.observedAtMs)}: ${content}`;
    if (totalChars + line.length + 1 > MAX_PROMPT_CHARS) {
      break;
    }
    selected.push({
      id: memory.id,
      content,
      observedAtMs: memory.observedAtMs,
      scope: memory.scope,
      kind: memory.kind,
    });
    totalChars += line.length + 1;
  }
  return selected;
}

function renderMemoryPrompt(memories: RecalledMemory[]): string {
  return [
    "Relevant memories for this request:",
    ...memories.map(
      (memory) =>
        `- Observed ${formatObservedDate(memory.observedAtMs)}: ${memory.content}`,
    ),
    "",
    "Treat these as possibly stale context. Current user instructions and repository evidence take priority.",
  ].join("\n");
}

const memoryRecallContext = definePromptContext({
  kind: "recall",
  version: 1,
  schema: memoryRecallContextSchema,
  renderPrompt: (content) => renderMemoryPrompt(content.memories),
});

/**
 * Build active memory recall contributions.
 *
 * Personal recall remains prompt-only so conversation reporting cannot widen
 * actor-scoped memory visibility.
 */
export async function createMemoryPromptContributions(
  context: MemoryRecallContext,
): Promise<UserPromptContribution[] | undefined> {
  if (!context.text.trim()) {
    return undefined;
  }
  const runtimeContext = memoryRuntimeContextSchema.parse({
    ...(context.conversationId
      ? { conversationId: context.conversationId }
      : {}),
    ...(context.actor ? { actor: context.actor } : {}),
    source: context.source,
  });
  const candidates = await createMemoryStore(context.db, runtimeContext, {
    ...(context.embedder ? { embedder: context.embedder } : {}),
    ...(context.maxVectorDistance !== undefined
      ? { maxVectorDistance: context.maxVectorDistance }
      : {}),
  }).recallMemories({
    query: context.text,
    limit: RECALL_CANDIDATE_LIMIT,
  });
  if (candidates.length === 0) {
    return undefined;
  }
  let relevantIds: string[];
  try {
    relevantIds = await context.agent.selectRelevantMemories({
      candidates: candidates.map(({ content, id }) => ({ content, id })),
      userRequest: context.text,
    });
  } catch {
    // Automatic recall is optional context; a relevance-model failure must not
    // prevent the user's turn from continuing without recalled memory.
    context.log.warn("memory_recall_selection_failed");
    return undefined;
  }
  const candidatesById = new Map(
    candidates.map((memory) => [memory.id, memory]),
  );
  const relevant = relevantIds
    .map((id) => candidatesById.get(id))
    .filter((memory): memory is MemoryRecord => memory !== undefined)
    .slice(0, DEFAULT_RECALL_LIMIT);
  const selected = selectPromptMemories(relevant);
  if (selected.length === 0) {
    return undefined;
  }
  if (selected.some((memory) => memory.scope === "personal")) {
    return [{ text: renderMemoryPrompt(selected) }];
  }
  return [memoryRecallContext({ memories: selected })];
}
