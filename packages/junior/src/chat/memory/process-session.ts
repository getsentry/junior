import { createHash } from "node:crypto";
import {
  getSourceKey,
  type PluginRunContext,
  type PluginRunTranscriptEntry,
  type PluginTaskContext,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  createMemoryStore,
  parseMemoryRow,
  type CreateMemoryInput,
  type CreateMemoryResult,
  type MemoryDb,
} from "./store";
import {
  createMemoryAgent,
  parseContradictedMemory,
  parseExtractedMemory,
  type ContradictedMemory,
  type ExtractedMemory,
  type MemoryExtractionResult,
} from "./agent";
import { MEMORY_KINDS, memoryRuntimeContextSchema } from "./types";
import {
  archivedMemory,
  capturedMemory,
  memoriesCapturedEvent,
  parseRecalledMemoryIds,
} from "./events";
import { loadActiveMemoryRows, retireMemoryRows } from "./lifecycle";

const MEMORY_TOOL_NAMES = new Set([
  "archiveMemory",
  "createMemory",
  "listMemories",
  "restoreMemory",
  "searchMemories",
]);
const MEMORY_TASK_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const extractedMemorySchema = z
  .object({
    content: z.string().min(1),
    expiresAtMs: z.number().finite().nullable(),
    kind: z.enum(MEMORY_KINDS),
    evidenceMessageIndices: z
      .array(z.number().int().nonnegative())
      .min(1)
      .max(10),
    statesChange: z.boolean().optional(),
  })
  .strict()
  .transform(parseExtractedMemory);
const contradictedMemoryCacheSchema = z
  .object({
    evidenceMessageIndices: z
      .array(z.number().int().nonnegative())
      .min(1)
      .max(10),
    id: z.string().min(1),
    replacementIndex: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .transform(parseContradictedMemory);
const extractedMemoryCacheSchema = z.union([
  z
    .object({
      // Only cache entries written before contradiction checks lack it.
      contradicted: z.array(contradictedMemoryCacheSchema).max(5).default([]),
      // Only cache entries written before Junior recorded plugin model cost
      // have it. Junior records that cost now.
      costUsd: z.number().finite().nonnegative().optional(),
      memories: z.array(extractedMemorySchema).max(5),
    })
    .strict()
    .transform(({ contradicted, memories }) => ({ contradicted, memories })),
  z
    .array(extractedMemorySchema)
    .max(5)
    .transform((memories) => ({ contradicted: [], memories })),
]);

/** Subject for a passively extracted memory, or drop when unproven. */
type MemorySubjectTarget = "drop" | "user" | "conversation";

function recordCapturedMemory(
  captured: ReturnType<typeof capturedMemory>[],
  archived: ReturnType<typeof archivedMemory>[],
  result: CreateMemoryResult,
): void {
  const capturedIds = new Set(captured.map((memory) => memory.id));
  for (const memory of result.archived ?? []) {
    // A memory captured and replaced in the same Turn is in neither list.
    if (!capturedIds.has(memory.id)) {
      archived.push(archivedMemory(memory, "superseded"));
    }
  }
  const supersededIds = new Set([
    ...(result.supersededIds ?? []),
    ...(result.archived ?? []).map((memory) => memory.id),
  ]);
  for (let index = captured.length - 1; index >= 0; index -= 1) {
    if (supersededIds.has(captured[index]!.id)) {
      captured.splice(index, 1);
    }
  }
  if (result.created || result.idempotent) {
    captured.push(capturedMemory(result.memory));
  }
}

/** A cited entry is a run-actor durable instruction evidence entry. */
function isRunActorInstruction(entry: PluginRunTranscriptEntry): boolean {
  return (
    entry.type === "message" &&
    entry.role === "user" &&
    entry.provenance?.authority === "instruction" &&
    entry.isRunActor === true
  );
}

/** A cited entry is valid public conversation evidence for shared knowledge. */
function isConversationEvidence(entry: PluginRunTranscriptEntry): boolean {
  if (entry.type === "toolResult") {
    return !entry.isError && Boolean(entry.text?.trim());
  }
  if (
    entry.type === "message" &&
    entry.role === "user" &&
    entry.provenance?.authority === "instruction" &&
    entry.isRunActor === false
  ) {
    return Boolean(entry.provenance.actor);
  }
  return (
    entry.type === "message" &&
    entry.role === "user" &&
    entry.provenance?.authority === "context"
  );
}

/** Resolve the deduplicated cited transcript entries, failing on bad indices. */
function citedEntries(
  indices: number[],
  transcript: PluginRunTranscriptEntry[],
): { valid: boolean; entries: PluginRunTranscriptEntry[] } {
  const seen = new Set<number>();
  const entries: PluginRunTranscriptEntry[] = [];
  for (const index of indices) {
    if (seen.has(index)) {
      continue;
    }
    seen.add(index);
    const entry = transcript[index];
    if (!entry) {
      return { valid: false, entries: [] };
    }
    entries.push(entry);
  }
  return { valid: entries.length > 0, entries };
}

/**
 * Verify an extracted memory against runtime-owned provenance on its cited
 * evidence. This is a deterministic authority boundary, not a model decision:
 * personal preferences require a single-actor run whose citations are all
 * run-actor instructions, conversation knowledge requires run-actor instruction
 * or valid public conversation evidence, and anything unproven (including
 * missing provenance) is dropped. Multi-actor runs interleave first-person
 * statements from different people, so they never store a preference regardless
 * of citations; a personal preference can wait for a single-actor run.
 */
function routeExtractedMemory(
  memory: ExtractedMemory,
  transcript: PluginRunTranscriptEntry[],
  run: Pick<PluginRunContext, "actor" | "actors" | "actorUserId">,
): MemorySubjectTarget {
  const cited = citedEntries(memory.evidenceMessageIndices, transcript);
  if (!cited.valid) {
    return "drop";
  }
  if (memory.kind === "preference") {
    // Only a run attributed to exactly one human run actor may store a preference.
    const exactlyOneHumanRunActor =
      run.actorUserId !== undefined &&
      run.actor !== undefined &&
      run.actor.platform !== "system" &&
      run.actors.length === 1 &&
      run.actors[0]?.platform !== "system";
    if (!exactlyOneHumanRunActor) {
      return "drop";
    }
    // Never downgrade an unproven first-person preference to conversation subject.
    return cited.entries.every(isRunActorInstruction) ? "user" : "drop";
  }
  return cited.entries.every(
    (entry) => isRunActorInstruction(entry) || isConversationEvidence(entry),
  )
    ? "conversation"
    : "drop";
}

/**
 * Verify a reported contradiction against runtime-owned provenance, as
 * routeExtractedMemory does for a new memory. Knowledge and procedures need
 * user or tool evidence. A preference needs its own User's instruction in a
 * single-actor run.
 */
function canRetireMemory(
  memory: { kind: ExtractedMemory["kind"]; subjectKey: string | null },
  contradicted: ContradictedMemory,
  transcript: PluginRunTranscriptEntry[],
  run: Pick<PluginRunContext, "actor" | "actors" | "actorUserId">,
): boolean {
  const target = routeExtractedMemory(
    {
      content: "contradiction",
      evidenceMessageIndices: contradicted.evidenceMessageIndices,
      expiresAtMs: null,
      kind: memory.kind,
      statesChange: false,
    },
    transcript,
    run,
  );
  if (target === "user") return memory.subjectKey === run.actorUserId;
  return target === "conversation";
}

function memoryIdempotencySuffix(
  memory: ExtractedMemory,
  target: MemorySubjectTarget,
): string {
  return createHash("sha256")
    .update(target)
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
  target: MemorySubjectTarget,
): CreateMemoryInput {
  return {
    content: memory.content,
    idempotencyKey: `session:${sourceKey}:${sessionId}:${memoryIdempotencySuffix(memory, target)}`,
    kind: memory.kind,
    ...(memory.statesChange ? { statesChange: true } : undefined),
    ...(memory.expiresAtMs !== null
      ? { expiresAtMs: memory.expiresAtMs }
      : undefined),
  };
}

async function getTaskExtraction(
  context: PluginTaskContext,
  extract: () => Promise<MemoryExtractionResult>,
): Promise<MemoryExtractionResult> {
  const cacheKey = `memory-extraction:${context.id}`;
  const cached = await context.state.get(cacheKey);
  if (cached !== undefined) {
    const parsed = extractedMemoryCacheSchema.safeParse(cached);
    if (parsed.success) {
      return parsed.data;
    }
    await context.state.delete(cacheKey);
  }
  const extraction = await extract();
  await context.state.set(cacheKey, extraction, MEMORY_TASK_STATE_TTL_MS);
  return extraction;
}

/**
 * Extract and store memories from a completed session plugin task.
 *
 * Memory owns learning after a run and reads only the plugin run data.
 * Explicit memory tools stay separate so retries do not reinterpret user
 * requests.
 */
export async function processMemorySession(
  context: PluginTaskContext,
): Promise<void> {
  const run = await context.run.load();
  // TODO(dcramer): Replace this hardcoded Source check when a plugin Run can
  // state whether passive memory extraction should run.
  if (run.source.kind !== "slack" && run.source.kind !== "web") {
    return;
  }
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
  const sourceKey = getSourceKey(run.source);
  // All memory is public, so a private Conversation never creates memory.
  if (!sourceKey || run.source.visibility !== "public") {
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
    ...(run.locationId ? { locationId: run.locationId } : undefined),
    ...(run.actor ? { actor: run.actor } : undefined),
    source: run.source,
    ...(run.actorUserId ? { userId: run.actorUserId } : undefined),
  });
  const agent = createMemoryAgent(context.model);
  const db = context.db as MemoryDb;
  const store = createMemoryStore(db, runtimeContext, {
    embedder: context.embedder,
    supersessionDecider: agent,
  });
  await store.archiveExpiredMemories();
  const extraction = await getTaskExtraction(context, async () => {
    const [existingMemories, recalledMemories] = await Promise.all([
      store.searchMemories({ limit: 10, query: evidenceText }),
      loadRecalledMemories(context, db),
    ]);
    return await agent.extractSessionMemories({
      existingMemories: existingMemories.map((memory) => ({
        content: memory.content,
      })),
      recalledMemories,
      actors: run.actors,
      transcript,
      runtimeContext,
    });
  });

  const captured: ReturnType<typeof capturedMemory>[] = [];
  const archived: ReturnType<typeof archivedMemory>[] = [];
  const results = new Map<number, CreateMemoryResult>();
  for (const [index, memory] of extraction.memories.entries()) {
    // The routing gate stays even though extraction is also actor-gated:
    // getTaskExtraction caches extraction output for 7 days, so a retry can replay
    // preference proposals cached before this gate existed.
    const target = routeExtractedMemory(memory, transcript, run);
    if (target === "drop") {
      continue;
    }
    const input = passiveInput(run.runId, memory, sourceKey, target);
    if (target === "conversation") {
      // oxlint-disable-next-line no-await-in-loop -- Write in order, so a later memory dedupes against an earlier one.
      const result = await store.createConversationMemory(input);
      results.set(index, result);
      recordCapturedMemory(captured, archived, result);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- Write in order, so a later memory dedupes against an earlier one.
    const result = await store.createMemory(input);
    results.set(index, result);
    recordCapturedMemory(captured, archived, result);
  }
  archived.push(
    ...(await retireContradictedMemories({
      contradicted: extraction.contradicted,
      db,
      results,
      run,
      transcript,
    })),
  );
  await context.events.emit(
    memoriesCapturedEvent({ archived, memories: captured }),
  );
}

/** Read the active memories that recall put into this Turn's prompt. */
async function loadRecalledMemories(context: PluginTaskContext, db: MemoryDb) {
  const ids = (
    await context.turnEvents.list({ eventName: "memories_recalled" })
  ).flatMap((event) => parseRecalledMemoryIds(event.version, event.content));
  const rows = await loadActiveMemoryRows(db, [...new Set(ids)], Date.now());
  return rows.map((row) => ({
    content: row.content,
    id: row.id,
    kind: row.kind,
  }));
}

/**
 * Archive recalled memories that the Turn's cited evidence contradicts. When
 * a memory captured in the same Turn states the current fact, link it.
 */
async function retireContradictedMemories(args: {
  contradicted: ContradictedMemory[];
  db: MemoryDb;
  results: Map<number, CreateMemoryResult>;
  run: PluginRunContext;
  transcript: PluginRunTranscriptEntry[];
}): Promise<ReturnType<typeof archivedMemory>[]> {
  if (args.contradicted.length === 0) return [];
  const { db } = args;
  const nowMs = Date.now();
  const rows = new Map(
    (
      await loadActiveMemoryRows(
        db,
        args.contradicted.map(({ id }) => id),
        nowMs,
      )
    ).map((row) => [row.id, row]),
  );
  const retired: ReturnType<typeof archivedMemory>[] = [];
  for (const contradicted of args.contradicted) {
    const row = rows.get(contradicted.id);
    if (
      !row ||
      !canRetireMemory(row, contradicted, args.transcript, args.run)
    ) {
      continue;
    }
    const replacement =
      contradicted.replacementIndex === null
        ? undefined
        : args.results.get(contradicted.replacementIndex)?.memory;
    // A new memory that resolved to this one confirms it.
    if (replacement?.id === row.id) continue;
    // oxlint-disable-next-line no-await-in-loop -- At most five bounded writes, each with its own replacement.
    const [archivedRow] = await retireMemoryRows(db, {
      ids: [row.id],
      nowMs,
      reason: "contradicted",
      supersededById: replacement?.id,
    });
    if (archivedRow) {
      retired.push(archivedMemory(parseMemoryRow(archivedRow), "contradicted"));
    }
  }
  return retired;
}
