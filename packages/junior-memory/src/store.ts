/**
 * SQL-backed memory store boundary.
 *
 * This module owns row parsing plus visible create/list/search/archive
 * operations. Visibility, expiration, and supersession are enforced before
 * records leave the store.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  isNotNull,
  like,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { cosineDistance } from "drizzle-orm/sql/functions";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import { z } from "zod";
import * as memorySqlSchema from "./db/schema";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_SCOPES,
  MEMORY_SOURCE_PLATFORMS,
  MEMORY_SUBJECT_TYPES,
  MEMORY_KINDS,
  memoryRuntimeContextSchema,
  type MemoryRuntimeContext,
  type MemoryScope,
} from "./types";
import {
  deriveMemoryScope,
  deriveMemorySubject,
  type ResolvedMemorySubject,
  deriveVisibleMemoryScopes,
  type ResolvedMemoryScope,
} from "./scope";

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_EXPIRED_ARCHIVE_LIMIT = 100;
const HIGH_CONFIDENCE_DUPLICATE_DISTANCE = 0.015;
const SUPERSESSION_CANDIDATE_LIMIT = 10;
const VECTOR_SEARCH_OVERFETCH = 4;
const MAX_MEMORY_CONTENT_CHARS = 4_000;
const EMBEDDING_METRIC = "cosine";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RELEVANCE_NEAR_TIE_DELTA = 0.01;
const SUPERSESSION_STOP_TERMS = new Set([
  "and",
  "for",
  "prefer",
  "prefers",
  "preference",
  "the",
  "use",
  "uses",
  "with",
]);

export type MemoryDb = PgDatabase<PgQueryResultHKT, typeof memorySqlSchema>;

interface SearchCandidate {
  memory: MemoryRecord;
  score: number;
}

interface MemoryEmbedding {
  model: string;
  provider: string;
  vector: number[];
}

const nonEmptyStringSchema = z.string().min(1);
const memoryContentSchema = z
  .string()
  .refine((content) => content.trim().length > 0, {
    message: "Memory content is required.",
  });
const numberSchema = z.number().finite();
const createMemoryInputSchema = z
  .object({
    content: memoryContentSchema,
    expiresAtMs: numberSchema.optional(),
    idempotencyKey: nonEmptyStringSchema,
    kind: z.enum(MEMORY_KINDS),
  })
  .strict();
const listMemoriesInputSchema = z
  .object({
    limit: numberSchema.optional(),
  })
  .strict();
const searchMemoriesInputSchema = z
  .object({
    limit: numberSchema.optional(),
    query: nonEmptyStringSchema,
  })
  .strict();
const archiveMemoryInputSchema = z
  .object({
    id: nonEmptyStringSchema,
    reason: nonEmptyStringSchema.optional(),
  })
  .strict();
const archiveExpiredMemoriesInputSchema = z
  .object({
    limit: numberSchema.optional(),
  })
  .strict();
const clockSchema = z.function({ input: [], output: numberSchema }).optional();
const memoryStoreOptionsSchema = z
  .object({
    now: clockSchema,
  })
  .strict();
const optionalNumberSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.coerce.number().optional(),
);
const optionalStringSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional(),
);
const optionalNonEmptyStringSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().min(1).optional(),
);
const memoryRowSchema = z
  .object({
    archivedAtMs: optionalNumberSchema,
    archiveReason: optionalStringSchema,
    content: memoryContentSchema,
    createdAtMs: z.coerce.number(),
    expiresAtMs: optionalNumberSchema,
    id: z.string().min(1),
    idempotencyKey: optionalStringSchema,
    observedAtMs: z.coerce.number(),
    scope: z.enum(MEMORY_SCOPES),
    scopeKey: z.string().min(1),
    sourceKey: z.string().min(1),
    sourcePlatform: z.enum(MEMORY_SOURCE_PLATFORMS),
    subjectKey: optionalNonEmptyStringSchema,
    subjectType: z.enum(MEMORY_SUBJECT_TYPES),
    supersededAtMs: optionalNumberSchema,
    supersededById: optionalStringSchema,
    kind: z.enum(MEMORY_KINDS),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.subjectType === "general") {
      if (row.subjectKey !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "General-subject memory rows must not have a subject key.",
          path: ["subjectKey"],
        });
      }
      return;
    }
    if (row.subjectKey === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "User and conversation memory rows require a subject key.",
        path: ["subjectKey"],
      });
    }
  });

const memoryRecordSchema = z
  .object({
    archivedAtMs: numberSchema.optional(),
    archiveReason: nonEmptyStringSchema.optional(),
    content: memoryContentSchema,
    createdAtMs: numberSchema,
    expiresAtMs: numberSchema.optional(),
    id: nonEmptyStringSchema,
    observedAtMs: numberSchema,
    scope: z.enum(MEMORY_SCOPES),
    subjectType: z.enum(MEMORY_SUBJECT_TYPES),
    supersededAtMs: numberSchema.optional(),
    supersededById: nonEmptyStringSchema.optional(),
    kind: z.enum(MEMORY_KINDS),
  })
  .strict();
const embeddingVectorSchema = z
  .array(numberSchema)
  .length(MEMORY_EMBEDDING_DIMENSIONS);
const embeddingResultSchema = z
  .object({
    dimensions: z.literal(MEMORY_EMBEDDING_DIMENSIONS),
    model: nonEmptyStringSchema,
    provider: nonEmptyStringSchema,
    vectors: z.array(embeddingVectorSchema),
  })
  .strict();

export type MemoryRecord = z.output<typeof memoryRecordSchema>;
export type CreateMemoryInput = z.output<typeof createMemoryInputSchema>;

/** Result of a memory write after idempotency checks. */
export interface CreateMemoryResult {
  created: boolean;
  memory: MemoryRecord;
}

export type ListMemoriesInput = z.output<typeof listMemoriesInputSchema>;

export type SearchMemoriesInput = z.output<typeof searchMemoriesInputSchema>;

export type ArchiveMemoryInput = z.output<typeof archiveMemoryInputSchema>;

export type ArchiveExpiredMemoriesInput = z.output<
  typeof archiveExpiredMemoriesInputSchema
>;

export interface ArchiveExpiredMemoriesResult {
  archivedCount: number;
}

export interface MemoryEmbeddingProvider {
  /** Embed normalized memory text for derived vector retrieval. */
  embedTexts(input: { texts: string[] }): Promise<{
    dimensions: number;
    model: string;
    provider: string;
    vectors: number[][];
  }>;
}

export interface MemorySupersessionInput {
  candidate: {
    content: string;
    kind: "preference";
  };
  existingMemories: [
    {
      content: string;
      id: string;
    },
    ...Array<{
      content: string;
      id: string;
    }>,
  ];
  runtimeContext: MemoryRuntimeContext;
}

export type MemorySupersessionDecision =
  | {
      decision: "supersedes_old";
      supersededIds: [string, ...string[]];
    }
  | {
      decision: "distinct" | "uncertain";
    };

export interface MemorySupersessionDecider {
  /** Decide whether a new preference clearly replaces active old preferences. */
  adjudicateSupersession(
    input: MemorySupersessionInput,
  ): Promise<MemorySupersessionDecision> | MemorySupersessionDecision;
}

export interface MemoryStoreOptions {
  embedder?: MemoryEmbeddingProvider;
  /** Maximum cosine distance for vector recall candidates. Model-dependent; tune when changing AI_EMBEDDING_MODEL. */
  maxVectorDistance?: number;
  now?: () => number;
  supersessionDecider?: MemorySupersessionDecider;
}

/** Context-bound storage operations for visible long-term memories. */
export interface MemoryStore {
  /** Archive expired memories visible in the current runtime context. */
  archiveExpiredMemories(
    input?: ArchiveExpiredMemoriesInput,
  ): Promise<ArchiveExpiredMemoriesResult>;
  /** Archive a visible memory in the current runtime context. */
  archiveMemory(input: ArchiveMemoryInput): Promise<MemoryRecord>;
  /** Store a personal memory for the current requester. */
  createMemory(input: CreateMemoryInput): Promise<CreateMemoryResult>;
  /** Store a conversation memory for the current source conversation. */
  createConversationMemory(
    input: CreateMemoryInput,
  ): Promise<CreateMemoryResult>;
  /** List active memories visible in the current runtime context. */
  listMemories(input: ListMemoriesInput): Promise<MemoryRecord[]>;
  /** Search active memories visible in the current runtime context. */
  searchMemories(input: SearchMemoriesInput): Promise<MemoryRecord[]>;
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function hashEmbeddedContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function idempotencyAliasId(args: {
  idempotencyKey: string;
  scope: ResolvedMemoryScope;
  targetId: string;
}): string {
  return `alias:${createHash("sha256")
    .update(args.scope.scope)
    .update("\0")
    .update(args.scope.scopeKey)
    .update("\0")
    .update(args.idempotencyKey)
    .update("\0")
    .update(args.targetId)
    .digest("hex")}`;
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(200, Math.max(1, Math.floor(value)));
}

/** Build the durable source attribution key from runtime-owned source fields. */
function sourceKey(ctx: MemoryRuntimeContext): string {
  if (ctx.source.platform === "local") {
    return ctx.source.conversationId;
  }
  const threadKey = ctx.source.threadTs ?? ctx.source.messageTs;
  if (!threadKey) {
    throw new Error(
      "Memory source requires a Slack message or thread timestamp.",
    );
  }
  return `slack:${ctx.source.teamId}:${ctx.source.channelId}:${threadKey}`;
}

/** Parse one SQL row into the public memory record projection. */
function parseMemoryRow(row: unknown): MemoryRecord {
  const parsed = memoryRowSchema.parse(row);
  return memoryRecordSchema.parse({
    id: parsed.id,
    scope: parsed.scope,
    kind: parsed.kind,
    subjectType: parsed.subjectType,
    content: parsed.content,
    observedAtMs: parsed.observedAtMs,
    createdAtMs: parsed.createdAtMs,
    ...(parsed.expiresAtMs !== undefined
      ? { expiresAtMs: parsed.expiresAtMs }
      : {}),
    ...(parsed.supersededAtMs !== undefined
      ? { supersededAtMs: parsed.supersededAtMs }
      : {}),
    ...(parsed.supersededById ? { supersededById: parsed.supersededById } : {}),
    ...(parsed.archivedAtMs !== undefined
      ? { archivedAtMs: parsed.archivedAtMs }
      : {}),
    ...(parsed.archiveReason ? { archiveReason: parsed.archiveReason } : {}),
  });
}

/** Build the scoped SQL predicate and ordered params for visible memory reads. */
function visibleScopePredicate(scopes: ResolvedMemoryScope[]): SQL | undefined {
  if (scopes.length === 0) {
    return undefined;
  }
  return or(
    ...scopes.map((scope) =>
      and(
        eq(juniorMemoryMemories.scope, scope.scope),
        eq(juniorMemoryMemories.scopeKey, scope.scopeKey),
      ),
    ),
  );
}

function activeVisiblePredicate(args: {
  nowMs: number;
  scopes: ResolvedMemoryScope[];
}): SQL | undefined {
  const scopePredicate = visibleScopePredicate(args.scopes);
  if (!scopePredicate) {
    return undefined;
  }
  return and(
    scopePredicate,
    isNull(juniorMemoryMemories.archivedAtMs),
    isNull(juniorMemoryMemories.supersededAtMs),
    isNull(juniorMemoryMemories.supersededById),
    or(
      isNull(juniorMemoryMemories.expiresAtMs),
      gt(juniorMemoryMemories.expiresAtMs, args.nowMs),
    ),
  );
}

/** Resolve retry attempts for the same scoped write idempotency key. */
async function findByIdempotencyKey(args: {
  db: MemoryDb;
  idempotencyKey: string;
  nowMs: number;
  scope: ResolvedMemoryScope;
}): Promise<MemoryRecord | undefined> {
  const activeRows = await args.db
    .select()
    .from(juniorMemoryMemories)
    .where(
      and(
        eq(juniorMemoryMemories.scope, args.scope.scope),
        eq(juniorMemoryMemories.scopeKey, args.scope.scopeKey),
        eq(juniorMemoryMemories.idempotencyKey, args.idempotencyKey),
        isNull(juniorMemoryMemories.archivedAtMs),
        isNull(juniorMemoryMemories.supersededAtMs),
        isNull(juniorMemoryMemories.supersededById),
        or(
          isNull(juniorMemoryMemories.expiresAtMs),
          gt(juniorMemoryMemories.expiresAtMs, args.nowMs),
        ),
      ),
    )
    .limit(1);
  if (activeRows[0]) {
    return parseMemoryRow(activeRows[0]);
  }

  const aliasRows = await args.db
    .select({ supersededById: juniorMemoryMemories.supersededById })
    .from(juniorMemoryMemories)
    .where(
      and(
        eq(juniorMemoryMemories.scope, args.scope.scope),
        eq(juniorMemoryMemories.scopeKey, args.scope.scopeKey),
        eq(juniorMemoryMemories.idempotencyKey, args.idempotencyKey),
        isNull(juniorMemoryMemories.archivedAtMs),
        isNotNull(juniorMemoryMemories.supersededAtMs),
        isNotNull(juniorMemoryMemories.supersededById),
        or(
          isNull(juniorMemoryMemories.expiresAtMs),
          gt(juniorMemoryMemories.expiresAtMs, args.nowMs),
        ),
      ),
    )
    .orderBy(
      desc(juniorMemoryMemories.createdAtMs),
      asc(juniorMemoryMemories.id),
    );
  for (const alias of aliasRows) {
    if (!alias.supersededById) {
      continue;
    }
    const rows = await args.db
      .select()
      .from(juniorMemoryMemories)
      .where(
        and(
          eq(juniorMemoryMemories.id, alias.supersededById),
          eq(juniorMemoryMemories.scope, args.scope.scope),
          eq(juniorMemoryMemories.scopeKey, args.scope.scopeKey),
          isNull(juniorMemoryMemories.archivedAtMs),
          isNull(juniorMemoryMemories.supersededAtMs),
          isNull(juniorMemoryMemories.supersededById),
          or(
            isNull(juniorMemoryMemories.expiresAtMs),
            gt(juniorMemoryMemories.expiresAtMs, args.nowMs),
          ),
        ),
      )
      .limit(1);
    if (rows[0]) {
      return parseMemoryRow(rows[0]);
    }
  }
  return undefined;
}

/**
 * Archive a bounded batch of expired active rows and remove their derived vectors.
 */
async function archiveExpiredMemoryBatch(args: {
  db: MemoryDb;
  idempotencyKey?: string;
  limit?: number;
  nowMs: number;
  scopes: ResolvedMemoryScope[];
}): Promise<ArchiveExpiredMemoriesResult> {
  const scopePredicate = visibleScopePredicate(args.scopes);
  if (!scopePredicate) {
    return { archivedCount: 0 };
  }
  const predicates: SQL[] = [
    scopePredicate,
    isNull(juniorMemoryMemories.archivedAtMs),
    isNull(juniorMemoryMemories.supersededAtMs),
    isNull(juniorMemoryMemories.supersededById),
    lte(juniorMemoryMemories.expiresAtMs, args.nowMs),
  ];
  if (args.idempotencyKey !== undefined) {
    predicates.push(
      eq(juniorMemoryMemories.idempotencyKey, args.idempotencyKey),
    );
  }

  const archivedIds = await args.db.transaction(async (tx) => {
    const expired = await tx
      .select({ id: juniorMemoryMemories.id })
      .from(juniorMemoryMemories)
      .where(and(...predicates))
      .orderBy(
        asc(juniorMemoryMemories.expiresAtMs),
        asc(juniorMemoryMemories.id),
      )
      .limit(boundedLimit(args.limit, DEFAULT_EXPIRED_ARCHIVE_LIMIT));
    const ids = expired.map((row) => row.id);
    if (ids.length === 0) {
      return [];
    }

    const archived = await tx
      .update(juniorMemoryMemories)
      .set({
        archivedAtMs: args.nowMs,
        archiveReason: "expired",
      })
      .where(and(inArray(juniorMemoryMemories.id, ids), ...predicates))
      .returning({ id: juniorMemoryMemories.id });
    const idsToClean = archived.map((row) => row.id);
    if (idsToClean.length > 0) {
      await tx
        .delete(juniorMemoryEmbeddings)
        .where(inArray(juniorMemoryEmbeddings.memoryId, idsToClean));
    }
    return idsToClean;
  });
  return { archivedCount: archivedIds.length };
}

function searchScore(memory: MemoryRecord, terms: string[]): number {
  const haystack = memory.content.toLowerCase();
  // Lexical score is a retrieval fallback signal, not a memory policy decision.
  return terms.reduce(
    (score, term) => score + (haystack.includes(term) ? 1 : 0),
    0,
  );
}

function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_'-]+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    ),
  ];
}

async function embedOne(
  embedder: MemoryEmbeddingProvider,
  text: string,
): Promise<MemoryEmbedding> {
  const normalized = normalizeContent(text);
  if (!normalized) {
    throw new Error("Embedding text is required.");
  }
  const result = embeddingResultSchema.parse(
    await embedder.embedTexts({ texts: [normalized] }),
  );
  if (result.vectors.length !== 1) {
    throw new Error("Embedding provider returned an unexpected vector count.");
  }
  return {
    model: result.model,
    provider: result.provider,
    vector: result.vectors[0],
  };
}

/** Store the derived vector index; failures must not block memory persistence. */
async function storeEmbedding(args: {
  content: string;
  db: MemoryDb;
  embedder: MemoryEmbeddingProvider | undefined;
  embedding?: MemoryEmbedding;
  memoryId: string;
  nowMs: number;
}): Promise<void> {
  if (!args.embedder && !args.embedding) {
    return;
  }
  try {
    const existing = await args.db
      .select({ memoryId: juniorMemoryEmbeddings.memoryId })
      .from(juniorMemoryEmbeddings)
      .where(eq(juniorMemoryEmbeddings.memoryId, args.memoryId))
      .limit(1);
    if (existing[0]) {
      return;
    }
  } catch {
    return;
  }
  let embedding: Awaited<ReturnType<typeof embedOne>>;
  if (args.embedding) {
    embedding = args.embedding;
  } else {
    const embedder = args.embedder;
    if (!embedder) {
      return;
    }
    try {
      embedding = await embedOne(embedder, args.content);
    } catch {
      return;
    }
  }
  try {
    await args.db
      .insert(juniorMemoryEmbeddings)
      .values({
        contentHash: hashEmbeddedContent(args.content),
        createdAtMs: args.nowMs,
        dimensions: MEMORY_EMBEDDING_DIMENSIONS,
        embedding: embedding.vector,
        memoryId: args.memoryId,
        metric: EMBEDDING_METRIC,
        model: embedding.model,
        provider: embedding.provider,
      })
      .onConflictDoNothing();
  } catch {
    return;
  }
}

function activeScopedSubjectPredicate(args: {
  kind: MemoryRecord["kind"];
  nowMs: number;
  scope: ResolvedMemoryScope;
  subject: ResolvedMemorySubject;
}): SQL {
  const predicate = and(
    eq(juniorMemoryMemories.scope, args.scope.scope),
    eq(juniorMemoryMemories.scopeKey, args.scope.scopeKey),
    eq(juniorMemoryMemories.kind, args.kind),
    eq(juniorMemoryMemories.subjectType, args.subject.subjectType),
    args.subject.subjectKey === undefined
      ? isNull(juniorMemoryMemories.subjectKey)
      : eq(juniorMemoryMemories.subjectKey, args.subject.subjectKey),
    isNull(juniorMemoryMemories.archivedAtMs),
    isNull(juniorMemoryMemories.supersededAtMs),
    isNull(juniorMemoryMemories.supersededById),
    or(
      isNull(juniorMemoryMemories.expiresAtMs),
      gt(juniorMemoryMemories.expiresAtMs, args.nowMs),
    ),
  );
  if (!predicate) {
    throw new Error("Memory duplicate predicate is empty.");
  }
  return predicate;
}

async function findExactDuplicateMemory(args: {
  content: string;
  db: MemoryDb;
  kind: MemoryRecord["kind"];
  nowMs: number;
  scope: ResolvedMemoryScope;
  subject: ResolvedMemorySubject;
}): Promise<MemoryRecord | undefined> {
  const rows = await args.db
    .select()
    .from(juniorMemoryMemories)
    .where(
      and(
        activeScopedSubjectPredicate(args),
        eq(juniorMemoryMemories.content, args.content),
      ),
    )
    .orderBy(
      desc(juniorMemoryMemories.createdAtMs),
      asc(juniorMemoryMemories.id),
    )
    .limit(1);
  return rows[0] ? parseMemoryRow(rows[0]) : undefined;
}

async function findVectorDuplicateMemory(args: {
  db: MemoryDb;
  embedding: MemoryEmbedding;
  kind: MemoryRecord["kind"];
  nowMs: number;
  scope: ResolvedMemoryScope;
  subject: ResolvedMemorySubject;
}): Promise<MemoryRecord | undefined> {
  const distance = cosineDistance(
    juniorMemoryEmbeddings.embedding,
    args.embedding.vector,
  );
  const rows = await args.db
    .select({
      contentHash: juniorMemoryEmbeddings.contentHash,
      distance,
      memory: juniorMemoryMemories,
    })
    .from(juniorMemoryMemories)
    .innerJoin(
      juniorMemoryEmbeddings,
      eq(juniorMemoryEmbeddings.memoryId, juniorMemoryMemories.id),
    )
    .where(
      and(
        activeScopedSubjectPredicate(args),
        eq(juniorMemoryEmbeddings.provider, args.embedding.provider),
        eq(juniorMemoryEmbeddings.model, args.embedding.model),
        eq(juniorMemoryEmbeddings.dimensions, MEMORY_EMBEDDING_DIMENSIONS),
        eq(juniorMemoryEmbeddings.metric, EMBEDDING_METRIC),
        lte(distance, HIGH_CONFIDENCE_DUPLICATE_DISTANCE),
      ),
    )
    .orderBy(
      distance,
      desc(juniorMemoryMemories.createdAtMs),
      asc(juniorMemoryMemories.id),
    )
    .limit(1);
  const row = rows[0];
  if (!row || hashEmbeddedContent(row.memory.content) !== row.contentHash) {
    return undefined;
  }
  return parseMemoryRow(row.memory);
}

async function rememberDuplicateIdempotency(args: {
  content: string;
  db: MemoryDb;
  duplicate: MemoryRecord;
  idempotencyKey?: string;
  nowMs: number;
  runtimeContext: MemoryRuntimeContext;
  scope: ResolvedMemoryScope;
  subject: ResolvedMemorySubject;
}): Promise<void> {
  if (args.idempotencyKey === undefined) {
    return;
  }
  await args.db
    .insert(juniorMemoryMemories)
    .values({
      content: args.content,
      createdAtMs: args.nowMs,
      expiresAtMs: args.duplicate.expiresAtMs,
      id: idempotencyAliasId({
        idempotencyKey: args.idempotencyKey,
        scope: args.scope,
        targetId: args.duplicate.id,
      }),
      idempotencyKey: args.idempotencyKey,
      observedAtMs: args.nowMs,
      scope: args.scope.scope,
      scopeKey: args.scope.scopeKey,
      sourceKey: sourceKey(args.runtimeContext),
      sourcePlatform: args.runtimeContext.source.platform,
      subjectKey: args.subject.subjectKey,
      subjectType: args.subject.subjectType,
      supersededAtMs: args.nowMs,
      supersededById: args.duplicate.id,
      kind: args.duplicate.kind,
    })
    .onConflictDoNothing();
}

async function listSupersessionCandidates(args: {
  content: string;
  db: MemoryDb;
  embedding?: MemoryEmbedding;
  kind: MemoryRecord["kind"];
  nowMs: number;
  scope: ResolvedMemoryScope;
  subject: ResolvedMemorySubject;
}): Promise<MemoryRecord[]> {
  const predicate = activeScopedSubjectPredicate(args);
  const terms = searchTerms(args.content).filter(
    (term) => !SUPERSESSION_STOP_TERMS.has(term),
  );
  const lexicalRows =
    terms.length > 0
      ? await args.db
          .select()
          .from(juniorMemoryMemories)
          .where(
            and(
              predicate,
              or(
                ...terms.map((term) =>
                  ilike(juniorMemoryMemories.content, `%${term}%`),
                ),
              ),
            ),
          )
      : [];
  const lexicalCandidates = lexicalRows
    .map(parseMemoryRow)
    .map((memory) => ({
      memory,
      score: searchScore(memory, terms),
    }))
    .filter((candidate) => candidate.score > 1)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.memory.createdAtMs - left.memory.createdAtMs ||
        left.memory.id.localeCompare(right.memory.id),
    )
    .map((candidate) => candidate.memory);

  const vectorCandidates = args.embedding
    ? await listVectorSupersessionCandidates({
        db: args.db,
        embedding: args.embedding,
        kind: args.kind,
        nowMs: args.nowMs,
        scope: args.scope,
        subject: args.subject,
      })
    : [];
  const byId = new Map<string, MemoryRecord>();
  for (const memory of [...lexicalCandidates, ...vectorCandidates]) {
    if (byId.size >= SUPERSESSION_CANDIDATE_LIMIT) {
      break;
    }
    byId.set(memory.id, memory);
  }
  return [...byId.values()];
}

async function listVectorSupersessionCandidates(args: {
  db: MemoryDb;
  embedding: MemoryEmbedding;
  kind: MemoryRecord["kind"];
  nowMs: number;
  scope: ResolvedMemoryScope;
  subject: ResolvedMemorySubject;
}): Promise<MemoryRecord[]> {
  const distance = cosineDistance(
    juniorMemoryEmbeddings.embedding,
    args.embedding.vector,
  );
  const rows = await args.db
    .select({
      contentHash: juniorMemoryEmbeddings.contentHash,
      distance,
      memory: juniorMemoryMemories,
    })
    .from(juniorMemoryMemories)
    .innerJoin(
      juniorMemoryEmbeddings,
      eq(juniorMemoryEmbeddings.memoryId, juniorMemoryMemories.id),
    )
    .where(
      and(
        activeScopedSubjectPredicate(args),
        eq(juniorMemoryEmbeddings.provider, args.embedding.provider),
        eq(juniorMemoryEmbeddings.model, args.embedding.model),
        eq(juniorMemoryEmbeddings.dimensions, MEMORY_EMBEDDING_DIMENSIONS),
        eq(juniorMemoryEmbeddings.metric, EMBEDDING_METRIC),
      ),
    )
    .orderBy(
      distance,
      desc(juniorMemoryMemories.createdAtMs),
      asc(juniorMemoryMemories.id),
    )
    .limit(SUPERSESSION_CANDIDATE_LIMIT);
  return rows.flatMap((row) => {
    if (hashEmbeddedContent(row.memory.content) !== row.contentHash) {
      return [];
    }
    return [parseMemoryRow(row.memory)];
  });
}

async function decideSupersededIds(args: {
  candidates: MemoryRecord[];
  content: string;
  decider: MemorySupersessionDecider | undefined;
  kind: MemoryRecord["kind"];
  runtimeContext: MemoryRuntimeContext;
}): Promise<string[]> {
  // Supersession is conservative: model uncertainty or decider failure leaves
  // both memories active rather than hiding a possibly valid old preference.
  if (
    args.kind !== "preference" ||
    !args.decider ||
    args.candidates.length === 0
  ) {
    return [];
  }
  const existingMemories = args.candidates.map((memory) => ({
    content: memory.content,
    id: memory.id,
  })) as MemorySupersessionInput["existingMemories"];
  const candidateIds = new Set(args.candidates.map((memory) => memory.id));
  try {
    const decision = await args.decider.adjudicateSupersession({
      candidate: {
        content: args.content,
        kind: "preference",
      },
      existingMemories,
      runtimeContext: args.runtimeContext,
    });
    if (decision.decision !== "supersedes_old") {
      return [];
    }
    return decision.supersededIds.filter((id) => candidateIds.has(id));
  } catch {
    return [];
  }
}

/** List active records for the runtime-derived visible scopes. */
async function listVisibleMemories(args: {
  db: MemoryDb;
  limit?: number;
  nowMs: number;
  scopes: ResolvedMemoryScope[];
}): Promise<MemoryRecord[]> {
  const predicate = activeVisiblePredicate(args);
  if (!predicate) {
    return [];
  }
  const limit = boundedLimit(args.limit, DEFAULT_LIST_LIMIT);
  const rows = await args.db
    .select()
    .from(juniorMemoryMemories)
    .where(predicate)
    .orderBy(
      desc(juniorMemoryMemories.createdAtMs),
      asc(juniorMemoryMemories.id),
    )
    .limit(limit);
  return rows.map(parseMemoryRow);
}

/** Search active visible records with the V1 lexical matcher. */
async function searchVisibleMemories(args: {
  db: MemoryDb;
  nowMs: number;
  query: string;
  scopes: ResolvedMemoryScope[];
}): Promise<MemoryRecord[]> {
  const terms = searchTerms(args.query);
  if (terms.length === 0) {
    return [];
  }
  const predicate = activeVisiblePredicate(args);
  if (!predicate) {
    return [];
  }
  const rows = await args.db
    .select()
    .from(juniorMemoryMemories)
    .where(
      and(
        predicate,
        or(
          ...terms.map((term) =>
            ilike(juniorMemoryMemories.content, `%${term}%`),
          ),
        ),
      ),
    );
  return rows.map(parseMemoryRow);
}

/** Search active visible records with exact pgvector cosine distance. */
async function searchVisibleVectorMemories(args: {
  db: MemoryDb;
  embedder: MemoryEmbeddingProvider | undefined;
  limit: number;
  maxDistance?: number;
  nowMs: number;
  query: string;
  scopes: ResolvedMemoryScope[];
}): Promise<SearchCandidate[]> {
  if (!args.embedder) {
    return [];
  }
  const predicate = activeVisiblePredicate(args);
  if (!predicate) {
    return [];
  }
  let embedding: Awaited<ReturnType<typeof embedOne>>;
  try {
    embedding = await embedOne(args.embedder, args.query);
  } catch {
    return [];
  }
  const distance = cosineDistance(
    juniorMemoryEmbeddings.embedding,
    embedding.vector,
  );
  const rows = await args.db
    .select({
      contentHash: juniorMemoryEmbeddings.contentHash,
      distance,
      memory: juniorMemoryMemories,
    })
    .from(juniorMemoryMemories)
    .innerJoin(
      juniorMemoryEmbeddings,
      eq(juniorMemoryEmbeddings.memoryId, juniorMemoryMemories.id),
    )
    .where(
      and(
        predicate,
        eq(juniorMemoryEmbeddings.provider, embedding.provider),
        eq(juniorMemoryEmbeddings.model, embedding.model),
        eq(juniorMemoryEmbeddings.dimensions, MEMORY_EMBEDDING_DIMENSIONS),
        eq(juniorMemoryEmbeddings.metric, EMBEDDING_METRIC),
      ),
    )
    .orderBy(
      distance,
      desc(juniorMemoryMemories.createdAtMs),
      asc(juniorMemoryMemories.id),
    )
    .limit(args.limit);
  return rows.flatMap((row) => {
    const distanceValue = Number(row.distance);
    if (
      row.distance === null ||
      !Number.isFinite(distanceValue) ||
      hashEmbeddedContent(row.memory.content) !== row.contentHash
    ) {
      return [];
    }
    if (args.maxDistance !== undefined && distanceValue > args.maxDistance) {
      return [];
    }
    return [
      {
        memory: parseMemoryRow(row.memory),
        score: 1 / (1 + Math.max(0, distanceValue)),
      },
    ];
  });
}

/** Score only observation age for near-tie reranking; this is not lifecycle decay. */
function observedAgeBoost(memory: MemoryRecord, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - memory.observedAtMs);
  if (ageMs <= 7 * ONE_DAY_MS) {
    return 0.15;
  }
  if (ageMs <= 30 * ONE_DAY_MS) {
    return 0.1;
  }
  if (ageMs <= 90 * ONE_DAY_MS) {
    return 0.05;
  }
  return 0;
}

/** Fuse retrieval candidates while keeping observed age to near-tie reranking. */
function mergeSearchCandidates(
  candidates: SearchCandidate[],
  nowMs: number,
): MemoryRecord[] {
  const byId = new Map<
    string,
    {
      memory: MemoryRecord;
      score: number;
    }
  >();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.memory.id);
    if (existing) {
      existing.score += candidate.score;
      continue;
    }
    byId.set(candidate.memory.id, {
      memory: candidate.memory,
      score: candidate.score,
    });
  }
  return [...byId.values()]
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (Math.abs(scoreDelta) > RELEVANCE_NEAR_TIE_DELTA) {
        return scoreDelta;
      }
      return (
        observedAgeBoost(right.memory, nowMs) -
          observedAgeBoost(left.memory, nowMs) ||
        right.memory.observedAtMs - left.memory.observedAtMs ||
        left.memory.id.localeCompare(right.memory.id)
      );
    })
    .map((candidate) => candidate.memory);
}

/** Create a context-bound SQL-backed store for explicit memory operations. */
export function createMemoryStore(
  db: MemoryDb,
  context: MemoryRuntimeContext,
  options: MemoryStoreOptions = {},
): MemoryStore {
  const runtimeContext = memoryRuntimeContextSchema.parse(context);
  const parsedOptions = memoryStoreOptionsSchema.parse({ now: options.now });
  const embedder = options.embedder;
  const maxVectorDistance = options.maxVectorDistance;
  const supersessionDecider = options.supersessionDecider;
  const getNowMs = parsedOptions.now ?? Date.now;

  async function archiveExpiredVisibleMemories(
    input: ArchiveExpiredMemoriesInput | undefined,
    nowMs: number,
  ): Promise<ArchiveExpiredMemoriesResult> {
    input = archiveExpiredMemoriesInputSchema.parse(input ?? {});
    return await archiveExpiredMemoryBatch({
      db,
      limit: input.limit,
      nowMs,
      scopes: deriveVisibleMemoryScopes(runtimeContext),
    });
  }

  /** Persist a memory under the plugin-derived scope and subject. */
  async function createScopedMemory(
    rawInput: CreateMemoryInput,
    scopeKind: MemoryScope,
  ): Promise<CreateMemoryResult> {
    const input = createMemoryInputSchema.parse(rawInput);
    const nowMs = getNowMs();
    const content = normalizeContent(input.content);
    const scope = deriveMemoryScope(runtimeContext, scopeKind);
    const subject = deriveMemorySubject(runtimeContext, scope);
    if (content.length > MAX_MEMORY_CONTENT_CHARS) {
      throw new Error("Memory content exceeds the maximum length.");
    }
    await archiveExpiredMemoryBatch({
      db,
      nowMs,
      scopes: [scope],
    });
    await archiveExpiredMemoryBatch({
      db,
      idempotencyKey: input.idempotencyKey,
      limit: 1,
      nowMs,
      scopes: [scope],
    });
    if (input.idempotencyKey !== undefined) {
      const idempotent = await findByIdempotencyKey({
        db,
        idempotencyKey: input.idempotencyKey,
        nowMs,
        scope,
      });
      if (idempotent) {
        await storeEmbedding({
          content: idempotent.content,
          db,
          embedder,
          memoryId: idempotent.id,
          nowMs,
        });
        return { created: false, memory: idempotent };
      }
    }

    const exactDuplicate = await findExactDuplicateMemory({
      content,
      db,
      kind: input.kind,
      nowMs,
      scope,
      subject,
    });
    if (exactDuplicate) {
      await rememberDuplicateIdempotency({
        content,
        db,
        duplicate: exactDuplicate,
        idempotencyKey: input.idempotencyKey,
        nowMs,
        runtimeContext,
        scope,
        subject,
      });
      await storeEmbedding({
        content: exactDuplicate.content,
        db,
        embedder,
        memoryId: exactDuplicate.id,
        nowMs,
      });
      return { created: false, memory: exactDuplicate };
    }

    let candidateEmbedding: MemoryEmbedding | undefined;
    if (embedder) {
      try {
        candidateEmbedding = await embedOne(embedder, content);
      } catch {
        candidateEmbedding = undefined;
      }
    }
    const vectorDuplicate = candidateEmbedding
      ? await findVectorDuplicateMemory({
          db,
          embedding: candidateEmbedding,
          kind: input.kind,
          nowMs,
          scope,
          subject,
        })
      : undefined;
    if (vectorDuplicate) {
      await rememberDuplicateIdempotency({
        content,
        db,
        duplicate: vectorDuplicate,
        idempotencyKey: input.idempotencyKey,
        nowMs,
        runtimeContext,
        scope,
        subject,
      });
      await storeEmbedding({
        content: vectorDuplicate.content,
        db,
        embedder,
        memoryId: vectorDuplicate.id,
        nowMs,
      });
      return { created: false, memory: vectorDuplicate };
    }

    let supersededIds: string[] = [];
    if (
      scopeKind === "personal" &&
      input.kind === "preference" &&
      supersessionDecider &&
      (input.expiresAtMs === undefined || input.expiresAtMs > nowMs)
    ) {
      const supersessionCandidates = await listSupersessionCandidates({
        content,
        db,
        ...(candidateEmbedding ? { embedding: candidateEmbedding } : {}),
        kind: input.kind,
        nowMs,
        scope,
        subject,
      });
      supersededIds = await decideSupersededIds({
        candidates: supersessionCandidates,
        content,
        decider: supersessionDecider,
        kind: input.kind,
        runtimeContext,
      });
    }

    const id = randomUUID();
    const rows = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(juniorMemoryMemories)
        .values({
          content,
          createdAtMs: nowMs,
          expiresAtMs: input.expiresAtMs,
          id,
          idempotencyKey: input.idempotencyKey,
          observedAtMs: nowMs,
          scope: scope.scope,
          scopeKey: scope.scopeKey,
          sourceKey: sourceKey(runtimeContext),
          sourcePlatform: runtimeContext.source.platform,
          subjectKey: subject.subjectKey,
          subjectType: subject.subjectType,
          kind: input.kind,
        })
        .onConflictDoNothing({
          target: [
            juniorMemoryMemories.scope,
            juniorMemoryMemories.scopeKey,
            juniorMemoryMemories.idempotencyKey,
          ],
          where: sql`${juniorMemoryMemories.idempotencyKey} IS NOT NULL AND ${juniorMemoryMemories.archivedAtMs} IS NULL AND ${juniorMemoryMemories.supersededAtMs} IS NULL AND ${juniorMemoryMemories.supersededById} IS NULL`,
        })
        .returning();
      const insertedMemory = inserted[0];
      if (!insertedMemory || supersededIds.length === 0) {
        return inserted;
      }
      const superseded = await tx
        .update(juniorMemoryMemories)
        .set({
          supersededAtMs: nowMs,
          supersededById: insertedMemory.id,
        })
        .where(
          and(
            inArray(juniorMemoryMemories.id, supersededIds),
            activeScopedSubjectPredicate({
              kind: input.kind,
              nowMs,
              scope,
              subject,
            }),
          ),
        )
        .returning({ id: juniorMemoryMemories.id });
      const idsToClean = superseded.map((row) => row.id);
      if (idsToClean.length > 0) {
        await tx
          .delete(juniorMemoryEmbeddings)
          .where(inArray(juniorMemoryEmbeddings.memoryId, idsToClean));
      }
      return inserted;
    });
    if (rows[0]) {
      const memory = parseMemoryRow(rows[0]);
      await storeEmbedding({
        content: memory.content,
        db,
        embedder,
        embedding: candidateEmbedding,
        memoryId: memory.id,
        nowMs,
      });
      return { created: true, memory };
    }

    const idempotent = await findByIdempotencyKey({
      db,
      idempotencyKey: input.idempotencyKey,
      nowMs,
      scope,
    });
    if (!idempotent) {
      throw new Error("Memory idempotency conflict did not resolve.");
    }
    await storeEmbedding({
      content: idempotent.content,
      db,
      embedder,
      memoryId: idempotent.id,
      nowMs,
    });
    return { created: false, memory: idempotent };
  }

  return {
    async archiveExpiredMemories(input) {
      return await archiveExpiredVisibleMemories(input, getNowMs());
    },

    async createMemory(input) {
      return await createScopedMemory(input, "personal");
    },

    async createConversationMemory(input) {
      return await createScopedMemory(input, "conversation");
    },

    async listMemories(input) {
      input = listMemoriesInputSchema.parse(input);
      const nowMs = getNowMs();
      const scopes = deriveVisibleMemoryScopes(runtimeContext);
      await archiveExpiredMemoryBatch({
        db,
        nowMs,
        scopes,
      });
      return await listVisibleMemories({
        db,
        limit: input.limit,
        nowMs,
        scopes,
      });
    },

    async searchMemories(input) {
      input = searchMemoriesInputSchema.parse(input);
      const nowMs = getNowMs();
      const scopes = deriveVisibleMemoryScopes(runtimeContext);
      await archiveExpiredMemoryBatch({
        db,
        nowMs,
        scopes,
      });
      const limit = boundedLimit(input.limit, DEFAULT_SEARCH_LIMIT);
      const vectorCandidates = await searchVisibleVectorMemories({
        db,
        embedder,
        limit: limit * VECTOR_SEARCH_OVERFETCH,
        ...(maxVectorDistance !== undefined ? { maxDistance: maxVectorDistance } : {}),
        nowMs,
        query: input.query,
        scopes,
      });
      const candidates = await searchVisibleMemories({
        db,
        nowMs,
        query: input.query,
        scopes,
      });
      const terms = searchTerms(input.query);
      const lexicalCandidates = candidates
        .map((memory) => ({ memory, score: searchScore(memory, terms) }))
        .filter((item) => item.score > 0);
      return mergeSearchCandidates(
        [...vectorCandidates, ...lexicalCandidates],
        nowMs,
      ).slice(0, limit);
    },

    async archiveMemory(input) {
      input = archiveMemoryInputSchema.parse(input);
      const nowMs = getNowMs();
      const scopes = deriveVisibleMemoryScopes(runtimeContext);
      const predicate = activeVisiblePredicate({ nowMs, scopes });
      const idPrefix = input.id.trim();
      if (!idPrefix) {
        throw new Error("Memory id is required.");
      }
      const rows = predicate
        ? await db
            .select()
            .from(juniorMemoryMemories)
            .where(
              and(
                predicate,
                or(
                  eq(juniorMemoryMemories.id, idPrefix),
                  like(juniorMemoryMemories.id, `${idPrefix}%`),
                ),
              ),
            )
            .orderBy(asc(juniorMemoryMemories.id))
            .limit(2)
        : [];
      if (rows.length === 0) {
        throw new Error("Memory was not found in the current context.");
      }
      if (rows.length > 1) {
        throw new Error("Memory id prefix is ambiguous.");
      }
      const memory = parseMemoryRow(rows[0]);
      const updated = await db
        .update(juniorMemoryMemories)
        .set({
          archivedAtMs: nowMs,
          archiveReason: input.reason ?? "user_removed",
        })
        .where(eq(juniorMemoryMemories.id, memory.id))
        .returning();
      await db
        .delete(juniorMemoryEmbeddings)
        .where(eq(juniorMemoryEmbeddings.memoryId, memory.id));
      return parseMemoryRow(updated[0]);
    },
  };
}
