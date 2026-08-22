import {
  definePromptContext,
  type UserPromptContribution,
  type Actor,
  type Identity,
  type PluginConversationEvents,
  type PluginLogger,
  type Source,
  type User,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { MemoryAgent, MemoryRecallResult } from "./agent";
import { memoriesRecalledEvent } from "./events";
import {
  createMemoryStore,
  type MemoryDb,
  type MemoryEmbeddingProvider,
  type MemoryRecord,
} from "./store";
import { memoryRuntimeContextSchema } from "./types";

const RECALL_CANDIDATE_LIMIT = 20;
const MAX_PROMPT_CHARS = 4_000;
const MAX_MEMORY_LINE_CHARS = 600;

export interface MemoryRecallContext {
  agent: Pick<MemoryAgent, "selectRelevantMemories">;
  conversationId?: string;
  db: MemoryDb;
  embedder?: MemoryEmbeddingProvider;
  events?: PluginConversationEvents;
  log: PluginLogger;
  locationId?: string;
  actor?: Actor;
  source: Source;
  text: string;
  users: {
    resolveActor(): Promise<{ identity: Identity; user?: User } | undefined>;
  };
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
    // Count is a safety rail only. Admission packs by MAX_PROMPT_CHARS.
    memories: z.array(recalledMemorySchema).min(1).max(RECALL_CANDIDATE_LIMIT),
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
      scope: memory.scope === "private" ? "personal" : "conversation",
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

function addUsd(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.round((left + right) * 1e12) / 1e12;
}

async function emitRecallOutcome(args: {
  costUsd?: number;
  events?: PluginConversationEvents;
  memories: string[];
}): Promise<void> {
  await args.events?.emit(
    memoriesRecalledEvent({
      memories: args.memories,
      ...(args.costUsd !== undefined ? { costUsd: args.costUsd } : undefined),
    }),
  );
}

const memoryRecallContext = definePromptContext({
  kind: "recall",
  version: 1,
  schema: memoryRecallContextSchema,
  renderPrompt: (content) => renderMemoryPrompt(content.memories),
});

/** Build active memory recall contributions. */
export async function createMemoryPromptContributions(
  context: MemoryRecallContext,
): Promise<UserPromptContribution[] | undefined> {
  if (!context.text.trim()) {
    return undefined;
  }
  const actorUser = (await context.users.resolveActor())?.user;
  const runtimeContext = memoryRuntimeContextSchema.parse({
    ...(context.conversationId
      ? { conversationId: context.conversationId }
      : undefined),
    ...(context.actor ? { actor: context.actor } : undefined),
    ...(context.locationId ? { locationId: context.locationId } : undefined),
    source: context.source,
    ...(actorUser ? { userId: actorUser.id } : undefined),
  });
  let embeddingCostUsd: number | undefined;
  const sourceEmbedder = context.embedder;
  const embedder = sourceEmbedder
    ? {
        async embedTexts(input: { texts: string[] }) {
          const result = await sourceEmbedder.embedTexts(input);
          embeddingCostUsd = addUsd(embeddingCostUsd, result.costUsd);
          return result;
        },
      }
    : undefined;
  const candidates = await createMemoryStore(context.db, runtimeContext, {
    embedder,
  }).recallMemories({
    query: context.text,
    limit: RECALL_CANDIDATE_LIMIT,
  });
  if (candidates.length === 0) {
    await emitRecallOutcome({
      ...(embeddingCostUsd !== undefined ? { costUsd: embeddingCostUsd } : undefined),
      events: context.events,
      memories: [],
    });
    return undefined;
  }
  let recall: MemoryRecallResult;
  try {
    recall = await context.agent.selectRelevantMemories({
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
  const relevant = recall.relevantIds
    .map((id) => candidatesById.get(id))
    .filter((memory): memory is MemoryRecord => memory !== undefined);
  const selected = selectPromptMemories(relevant);
  const costUsd = addUsd(embeddingCostUsd, recall.costUsd);
  await emitRecallOutcome({
    ...(costUsd !== undefined ? { costUsd } : undefined),
    events: context.events,
    memories: selected.map(({ id }) => id),
  });
  if (selected.length === 0) {
    return undefined;
  }
  return [memoryRecallContext({ memories: selected })];
}
