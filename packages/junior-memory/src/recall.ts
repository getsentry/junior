import {
  definePromptContext,
  type UserPromptContribution,
  type Actor,
  type Identity,
  type PluginConversationEvents,
  type PluginLogger,
  type PluginReranker,
  type Source,
  type User,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
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
// Lowest reranker score that admits a candidate. Tuned for the default
// `voyage/rerank-2.5-lite`; retune it if the reranking model changes.
// Measured 2026-11-03 on 28 queries against 20 memories (memory test and eval
// fixtures, plus 11 small-talk queries):
// - 0.55 kept 12 of 19 relevant pairs, admitted 3 off-topic pairs (max 0.626),
//   and kept every small-talk query empty (max 0.547).
// - 0.50 kept 13, admitted 4, and gave 1 of 11 small-talk queries a memory.
// - Clear matches scored 0.63-0.93. Indirect matches scored 0.37-0.60.
const RECALL_MIN_RERANK_SCORE = 0.55;
// A message with several requests scores each memory low against the whole
// text: "Switch to the other configured profile first. Gut check" scored 0.48
// against a memory that defines "gut check", and "Gut check" alone scored 0.86
// (voyage/rerank-2.5-lite, 2026-11-04). Recall also ranks each sentence and
// keeps the best score per memory. The cap bounds rerank calls for long text.
const MAX_RECALL_SENTENCE_QUERIES = 5;

export interface MemoryRecallContext {
  conversationId?: string;
  db: MemoryDb;
  embedder?: MemoryEmbeddingProvider;
  events?: PluginConversationEvents;
  log: PluginLogger;
  locationId?: string;
  actor?: Actor;
  reranker: PluginReranker;
  setSpanAttributes(attributes: Record<string, number>): void;
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
    // Stored version 1 uses the old scope labels. Prompt rendering ignores them.
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

/** Return the whole text, plus each sentence when the text has more than one. */
function recallQueries(text: string): string[] {
  const sentences = Array.from(
    new Intl.Segmenter("en", { granularity: "sentence" }).segment(text),
    ({ segment }) => segment.trim(),
  ).filter(Boolean);
  if (sentences.length < 2) {
    return [text];
  }
  return [text, ...sentences.slice(0, MAX_RECALL_SENTENCE_QUERIES)];
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
  const embedder: MemoryEmbeddingProvider | undefined = sourceEmbedder
    ? {
        model: sourceEmbedder.model,
        provider: sourceEmbedder.provider,
        async embedTexts(input) {
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
      ...(embeddingCostUsd !== undefined
        ? { costUsd: embeddingCostUsd }
        : undefined),
      events: context.events,
      memories: [],
    });
    return undefined;
  }
  // Counts and scores only: recall diagnostics never carry query or memory
  // text. They sit on the `plugin.hook userPrompt` span next to its latency.
  context.setSpanAttributes({
    "app.memory.recall.candidate.count": candidates.length,
  });
  const documents = candidates.map(({ content }) => content);
  let reranks: Array<{ costUsd?: number; scores: number[] }>;
  try {
    reranks = await Promise.all(
      recallQueries(context.text).map((query) =>
        context.reranker.rerank({ documents, query }),
      ),
    );
  } catch (error) {
    // Automatic recall is optional context; a reranker failure must not
    // prevent the user's turn from continuing without recalled memory.
    // Log only the error class; provider messages can echo request text.
    context.log.warn("memory_recall_rerank_failed", {
      "error.type": error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
  const scores = documents.map((_, index) =>
    Math.max(...reranks.map((rerank) => rerank.scores[index]!)),
  );
  // Sort is stable, so equal scores keep retrieval rank order.
  const relevant = candidates
    .map((memory, index) => ({ memory, score: scores[index]! }))
    .filter(({ score }) => score >= RECALL_MIN_RERANK_SCORE)
    .sort((left, right) => right.score - left.score)
    .map(({ memory }) => memory);
  const selected = selectPromptMemories(relevant);
  context.setSpanAttributes({
    "app.memory.recall.admitted.count": relevant.length,
    "app.memory.recall.injected.count": selected.length,
    "app.memory.recall.score.max": Math.max(...scores),
  });
  const costUsd = reranks.reduce(
    (total, rerank) => addUsd(total, rerank.costUsd),
    embeddingCostUsd,
  );
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
