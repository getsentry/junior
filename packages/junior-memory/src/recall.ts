import {
  definePromptContext,
  type UserPromptContribution,
  type Actor,
  type Identity,
  pluginBriefSchema,
  type PluginBrief,
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
const MAX_RECALL_BRIEFS = 2;
const MAX_BRIEF_PROMPT_CHARS = 3_000;
const MAX_BRIEF_DECISIONS = 5;
const MAX_BRIEF_LINKS = 5;

export interface MemoryRecallContext {
  agent: Pick<MemoryAgent, "selectRelevantMemories">;
  conversationId?: string;
  briefs: {
    readLatest(
      conversationIds: readonly string[],
    ): Promise<Record<string, PluginBrief>>;
  };
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

function addUsd(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.round((left + right) * 1e12) / 1e12;
}

async function emitRecallOutcome(args: {
  briefs: string[];
  costUsd?: number;
  events?: PluginConversationEvents;
  memories: string[];
}): Promise<void> {
  await args.events?.emit(
    memoriesRecalledEvent({
      memories: args.memories,
      ...(args.briefs.length > 0 ? { briefs: args.briefs } : undefined),
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

const recallBriefsContextSchema = z
  .object({
    briefs: z.array(pluginBriefSchema).min(1).max(MAX_RECALL_BRIEFS),
  })
  .strict();

function renderBriefs(briefs: PluginBrief[]): string {
  return briefs
    .map((brief) =>
      [
        `Brief from Conversation ${brief.conversationId}: ${brief.summary}`,
        `Outcome (${brief.outcome.status}): ${brief.outcome.text}`,
        ...brief.decisions.map(
          (decision) => `Decision (${decision.kind}): ${decision.text}`,
        ),
        ...brief.links.map((link) => `- ${link.label}: ${link.url}`),
      ].join("\n"),
    )
    .join("\n\n");
}

function packBriefs(briefs: PluginBrief[]): PluginBrief[] {
  let packed = briefs.map((brief) => ({
    ...brief,
    decisions: brief.decisions.slice(0, MAX_BRIEF_DECISIONS),
    links: brief.links.slice(0, MAX_BRIEF_LINKS),
  }));
  if (renderBriefs(packed).length > MAX_BRIEF_PROMPT_CHARS) {
    packed = packed.slice(0, 1);
  }
  while (
    renderBriefs(packed).length > MAX_BRIEF_PROMPT_CHARS &&
    packed.some((brief) => brief.links.length > 0)
  ) {
    for (let index = packed.length - 1; index >= 0; index -= 1) {
      const brief = packed[index];
      if (brief && brief.links.length > 0) {
        brief.links.pop();
        break;
      }
    }
  }
  while (
    renderBriefs(packed).length > MAX_BRIEF_PROMPT_CHARS &&
    packed.some((brief) => brief.decisions.length > 0)
  ) {
    for (let index = packed.length - 1; index >= 0; index -= 1) {
      const brief = packed[index];
      if (brief && brief.decisions.length > 0) {
        brief.decisions.pop();
        break;
      }
    }
  }
  return packed;
}

const recallBriefsContext = definePromptContext({
  kind: "recall_briefs",
  version: 1,
  schema: recallBriefsContextSchema,
  renderPrompt: ({ briefs }) => renderBriefs(briefs),
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
      ...(embeddingCostUsd !== undefined
        ? { costUsd: embeddingCostUsd }
        : undefined),
      briefs: [],
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
  const selectedIds = new Set(selected.map(({ id }) => id));
  const conversationIds = [
    ...new Set(
      relevant
        .filter((memory) => selectedIds.has(memory.id))
        .map((memory) => memory.conversationId)
        .filter((conversationId): conversationId is string =>
          Boolean(conversationId),
        ),
    ),
  ]
    .filter((conversationId) => conversationId !== context.conversationId)
    .slice(0, MAX_RECALL_BRIEFS);
  let briefs: PluginBrief[] = [];
  if (conversationIds.length > 0) {
    try {
      const briefsByConversation =
        await context.briefs.readLatest(conversationIds);
      briefs = conversationIds.flatMap((conversationId) => {
        const brief = briefsByConversation[conversationId];
        return brief ? [brief] : [];
      });
    } catch {
      context.log.warn("memory_recall_brief_read_failed");
    }
  }
  const renderedBriefs = packBriefs(briefs);
  const costUsd = addUsd(embeddingCostUsd, recall.costUsd);
  await emitRecallOutcome({
    briefs: renderedBriefs.map(({ conversationId }) => conversationId),
    ...(costUsd !== undefined ? { costUsd } : undefined),
    events: context.events,
    memories: selected.map(({ id }) => id),
  });
  if (selected.length === 0) {
    return undefined;
  }
  return [
    memoryRecallContext({ memories: selected }),
    ...(renderedBriefs.length > 0
      ? [recallBriefsContext({ briefs: renderedBriefs })]
      : []),
  ];
}
