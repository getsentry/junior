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
import { getSourceKey } from "@sentry/junior-plugin-api";
import * as memorySqlSchema from "./db/schema";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import { rankMemoryMatches, type MemoryMatch } from "./ranking";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_SCOPES,
  MEMORY_SOURCE_PLATFORMS,
  MEMORY_SUBJECT_TYPES,
  MEMORY_KINDS,
  memoryRuntimeContextSchema,
  type MemoryRuntimeContext,
  type MemorySourcePlatform,
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
const PREFERENCE_ADJUDICATION_CANDIDATE_LIMIT = 10;
const PREFERENCE_ADJUDICATION_VECTOR_LIMIT = 5;
/** Explicit search overfetch: keep a wider fusion window for tool/CLI search. */
const SEARCH_RETRIEVAL_OVERFETCH = 4;
/**
 * Automatic recall overfetch. Recall already asks for ~20 candidates before the
 * relevance gate, so each hybrid leg only needs a small top-k probe.
 */
const RECALL_RETRIEVAL_OVERFETCH = 2;
/**
 * Absolute ceiling per retrieval leg. Matches the store limit ceiling so a
 * single healthy leg can still fill the caller's requested result window.
 */
const MAX_RETRIEVAL_LEG_CANDIDATES = 200;
/** Cap ts_rank_cd work after GIN filtering; ranking is not indexable. */
const MAX_LEXICAL_RANK_CANDIDATES = 200;
/** Expand the GIN match window before ts_rank_cd, still under the hard cap. */
const LEXICAL_RANK_WINDOW_MULTIPLIER = 4;
/** Bound query text before embedding / FTS construction. */
const MAX_RETRIEVAL_QUERY_CHARS = 1_500;
const MAX_MEMORY_CONTENT_CHARS = 4_000;
const EMBEDDING_METRIC = "cosine";
/**
 * Cosine distance cutoff for automatic recall only (not explicit search).
 * Tuned for text-embedding-3-small; retune if the embedding model changes.
 */
const RECALL_MAX_VECTOR_DISTANCE = 0.45;

export type MemoryDb = PgDatabase<PgQueryResultHKT, typeof memorySqlSchema>;

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
    locationId: optionalNonEmptyStringSchema,
    observedAtMs: z.coerce.number(),
    searchVector: z.string().optional(),
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

function storedMemorySource(
  source: MemoryRuntimeContext["source"],
): MemorySourcePlatform {
  if (source.kind === "resource_event") {
    throw new Error("Resource event Source cannot own a Memory.");
  }
  return source.kind;
}

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
    costUsd: z.number().finite().nonnegative().optional(),
    dimensions: z.literal(MEMORY_EMBEDDING_DIMENSIONS),
    model: nonEmptyStringSchema,
    provider: nonEmptyStringSchema,
    vectors: z.array(embeddingVectorSchema),
  })
  .strict();
const memorySupersessionCandidateSchema = z
  .object({
    content: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();
const memorySupersessionCandidatesSchema = z
  .array(memorySupersessionCandidateSchema)
  .min(1)
  .max(PREFERENCE_ADJUDICATION_CANDIDATE_LIMIT);
const supersededIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(PREFERENCE_ADJUDICATION_CANDIDATE_LIMIT);

/** Validated preference comparison input supplied to a supersession decider. */
export const memorySupersessionInputSchema = z
  .object({
    candidate: z
      .object({
        content: z.string().min(1),
        kind: z.literal("preference"),
      })
      .strict(),
    existingMemories: memorySupersessionCandidatesSchema,
    runtimeContext: memoryRuntimeContextSchema,
  })
  .strict();

/**
 * Validated preference decision whose referenced ids must come from the
 * supplied existing memories.
 */
export const memorySupersessionDecisionSchema = z.discriminatedUnion(
  "decision",
  [
    z
      .object({
        decision: z.literal("duplicate"),
        duplicateId: z.string().min(1),
      })
      .strict(),
    z
      .object({
        decision: z.literal("supersedes_old"),
        supersededIds: supersededIdsSchema,
      })
      .strict(),
    z
      .object({
        decision: z.enum(["distinct", "uncertain"]),
      })
      .strict(),
  ],
);

export type MemoryRecord = z.output<typeof memoryRecordSchema>;
export type CreateMemoryInput = z.output<typeof createMemoryInputSchema>;

/** Result of a memory write after idempotency checks. */
export interface CreateMemoryResult {
  created: boolean;
  /** True when this call found the memory previously written for the same input identity. */
  idempotent?: true;
  memory: MemoryRecord;
  /** Memory ids made inactive by this write. */
  supersededIds?: string[];
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
    costUsd?: number;
    dimensions: number;
    model: string;
    provider: string;
    vectors: number[][];
  }>;
}

export type MemorySupersessionInput = z.output<
  typeof memorySupersessionInputSchema
>;

export type MemorySupersessionDecision = z.output<
  typeof memorySupersessionDecisionSchema
>;

export interface MemorySupersessionDecider {
  /** Classify a new preference against related active preferences. */
  adjudicateSupersession(
    input: MemorySupersessionInput,
  ): Promise<MemorySupersessionDecision> | MemorySupersessionDecision;
}

export interface MemoryStoreOptions {
  embedder?: MemoryEmbeddingProvider;
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
  /** Store a memory about the current User. The Source sets access. */
  createMemory(input: CreateMemoryInput): Promise<CreateMemoryResult>;
  /** Store a memory about the current Conversation. The Source sets access. */
  createConversationMemory(
    input: CreateMemoryInput,
  ): Promise<CreateMemoryResult>;
  /** List active memories visible in the current runtime context. */
  listMemories(input: ListMemoriesInput): Promise<MemoryRecord[]>;
  /**
   * Retrieve a broad relevance-ranked candidate window for automatic recall.
   * Prompt admission remains owned by the recall boundary.
   */
  recallMemories(input: SearchMemoriesInput): Promise<MemoryRecord[]>;
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

/** Build the stored key for the Source. */
function sourceKey(ctx: MemoryRuntimeContext): string {
  const key = getSourceKey(ctx.source);
  if (!key) {
    throw new Error("Memory Source has no stable key.");
  }
  return key;
}

/** Parse one SQL row into the public memory projection. */
export function parseMemoryRow(row: unknown): MemoryRecord {
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
      : undefined),
    ...(parsed.supersededAtMs !== undefined
      ? { supersededAtMs: parsed.supersededAtMs }
      : undefined),
    ...(parsed.supersededById ? { supersededById: parsed.supersededById } : undefined),
    ...(parsed.archivedAtMs !== undefined
      ? { archivedAtMs: parsed.archivedAtMs }
      : undefined),
    ...(parsed.archiveReason ? { archiveReason: parsed.archiveReason } : undefined),
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

/** Build the active-row predicate for already-authorized memory scopes. */
export function activeVisiblePredicate(args: {
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
interface IdempotencyMatch {
  memory: MemoryRecord;
  outcome: "created" | "duplicate";
}

async function findByIdempotencyKey(args: {
  db: MemoryDb;
  idempotencyKey: string;
  nowMs: number;
  scope: ResolvedMemoryScope;
}): Promise<IdempotencyMatch | undefined> {
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
    return { memory: parseMemoryRow(activeRows[0]), outcome: "created" };
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
      return { memory: parseMemoryRow(rows[0]), outcome: "duplicate" };
    }
  }
  return undefined;
}

/**
 * Archive a bounded batch of expired active rows and remove their derived vectors.
 */
export async function archiveExpiredMemoryBatch(args: {
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

function denseRanks<T>(
  values: T[],
  key: (value: T) => string | number,
): number[] {
  let previous: string | number | undefined;
  let rank = 0;
  return values.map((value, index) => {
    const current = key(value);
    if (index === 0 || current !== previous) {
      rank = index + 1;
      previous = current;
    }
    return rank;
  });
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
    eq(juniorMemoryMemories.subjectKey, args.subject.subjectKey),
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
      locationId: args.runtimeContext.locationId,
      observedAtMs: args.nowMs,
      scope: args.scope.scope,
      scopeKey: args.scope.scopeKey,
      sourceKey: sourceKey(args.runtimeContext),
      sourcePlatform: storedMemorySource(args.runtimeContext.source),
      subjectKey: args.subject.subjectKey,
      subjectType: args.subject.subjectType,
      supersededAtMs: args.nowMs,
      supersededById: args.duplicate.id,
      kind: args.duplicate.kind,
    })
    .onConflictDoNothing();
}

/** Select semantic preferences, then fill the window by recency for unembedded records. */
async function listPreferenceAdjudicationCandidates(args: {
  db: MemoryDb;
  embedding?: MemoryEmbedding;
  nowMs: number;
  scope: ResolvedMemoryScope;
  subject: ResolvedMemorySubject;
}): Promise<MemoryRecord[]> {
  const vectorCandidates = args.embedding
    ? await listVectorPreferenceAdjudicationCandidates({
        db: args.db,
        embedding: args.embedding,
        nowMs: args.nowMs,
        scope: args.scope,
        subject: args.subject,
      })
    : [];
  const recentCandidates = (
    await args.db
      .select()
      .from(juniorMemoryMemories)
      .where(
        activeScopedSubjectPredicate({
          ...args,
          kind: "preference",
        }),
      )
      .orderBy(
        desc(juniorMemoryMemories.createdAtMs),
        asc(juniorMemoryMemories.id),
      )
      .limit(PREFERENCE_ADJUDICATION_CANDIDATE_LIMIT)
  ).map(parseMemoryRow);
  return [
    ...new Map(
      [...vectorCandidates, ...recentCandidates].map((memory) => [
        memory.id,
        memory,
      ]),
    ).values(),
  ].slice(0, PREFERENCE_ADJUDICATION_CANDIDATE_LIMIT);
}

async function listVectorPreferenceAdjudicationCandidates(args: {
  db: MemoryDb;
  embedding: MemoryEmbedding;
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
        activeScopedSubjectPredicate({ ...args, kind: "preference" }),
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
    .limit(PREFERENCE_ADJUDICATION_VECTOR_LIMIT);
  return rows.flatMap((row) => {
    if (hashEmbeddedContent(row.memory.content) !== row.contentHash) {
      return [];
    }
    return [parseMemoryRow(row.memory)];
  });
}

type PreferenceAdjudicationResult =
  | { decision: "create" }
  | { decision: "duplicate"; memory: MemoryRecord }
  | { decision: "supersede"; ids: [string, ...string[]] };

/**
 * Normalize a preference decision to known duplicate or supersession targets.
 * Uncertainty, invalid ids, and model failure leave existing memories active.
 */
async function adjudicatePreferenceCandidate(args: {
  candidates: MemoryRecord[];
  content: string;
  decider: MemorySupersessionDecider;
  runtimeContext: MemoryRuntimeContext;
}): Promise<PreferenceAdjudicationResult> {
  const [firstCandidate, ...remainingCandidates] = args.candidates;
  if (!firstCandidate) {
    return { decision: "create" };
  }
  const existingMemories = [
    { content: firstCandidate.content, id: firstCandidate.id },
    ...remainingCandidates.map((memory) => ({
      content: memory.content,
      id: memory.id,
    })),
  ];
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
    if (decision.decision === "duplicate") {
      const memory = args.candidates.find(
        (candidate) => candidate.id === decision.duplicateId,
      );
      return memory
        ? { decision: "duplicate", memory }
        : { decision: "create" };
    }
    if (decision.decision === "supersedes_old") {
      const ids = decision.supersededIds.filter((id) => candidateIds.has(id));
      const [firstId, ...remainingIds] = ids;
      return firstId
        ? { decision: "supersede", ids: [firstId, ...remainingIds] }
        : { decision: "create" };
    }
    return { decision: "create" };
  } catch {
    return { decision: "create" };
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

function normalizeRetrievalQuery(query: string): string {
  const normalized = query.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_RETRIEVAL_QUERY_CHARS) {
    return normalized;
  }
  return normalized.slice(0, MAX_RETRIEVAL_QUERY_CHARS).trimEnd();
}

function retrievalLegLimit(limit: number, overfetch: number): number {
  const requested = Math.max(1, limit);
  const withOverfetch = requested * Math.max(1, overfetch);
  // Never return fewer candidates than the caller asked for. A hard overfetch
  // cap below `limit` under-fills when one modality is empty or both overlap.
  return Math.min(
    MAX_RETRIEVAL_LEG_CANDIDATES,
    Math.max(requested, withOverfetch),
  );
}

/** Search a bounded active candidate set with PostgreSQL full-text ranking. */
async function searchVisibleLexicalMemories(args: {
  db: MemoryDb;
  limit: number;
  nowMs: number;
  query: string;
  scopes: ResolvedMemoryScope[];
}): Promise<MemoryMatch[]> {
  const predicate = activeVisiblePredicate(args);
  if (!predicate) {
    return [];
  }
  const query = normalizeRetrievalQuery(args.query);
  if (!query) {
    return [];
  }
  const queryVector = sql`to_tsvector('english', ${query})`;
  const tsquery = sql`(
    SELECT COALESCE(
      string_agg(quote_literal(term), ' | ')::tsquery,
      ''::tsquery
    )
    FROM unnest(tsvector_to_array(${queryVector})) AS query_terms(term)
  )`;
  // GIN filter first, then rank only a bounded recent match window.
  const candidateLimit = Math.min(
    MAX_LEXICAL_RANK_CANDIDATES,
    args.limit * LEXICAL_RANK_WINDOW_MULTIPLIER,
  );
  const candidates = args.db
    .select()
    .from(juniorMemoryMemories)
    .where(
      and(predicate, sql`${juniorMemoryMemories.searchVector} @@ ${tsquery}`),
    )
    .orderBy(
      desc(juniorMemoryMemories.observedAtMs),
      asc(juniorMemoryMemories.id),
    )
    .limit(candidateLimit)
    .as("lexical_candidates");
  const textRank = sql<number>`ts_rank_cd(${candidates.searchVector}, ${tsquery})`;
  const rows = await args.db
    .select({
      memory: {
        archiveReason: candidates.archiveReason,
        archivedAtMs: candidates.archivedAtMs,
        content: candidates.content,
        createdAtMs: candidates.createdAtMs,
        expiresAtMs: candidates.expiresAtMs,
        id: candidates.id,
        idempotencyKey: candidates.idempotencyKey,
        kind: candidates.kind,
        observedAtMs: candidates.observedAtMs,
        scope: candidates.scope,
        scopeKey: candidates.scopeKey,
        searchVector: candidates.searchVector,
        sourceKey: candidates.sourceKey,
        sourcePlatform: candidates.sourcePlatform,
        subjectKey: candidates.subjectKey,
        subjectType: candidates.subjectType,
        supersededAtMs: candidates.supersededAtMs,
        supersededById: candidates.supersededById,
      },
      textRank,
    })
    .from(candidates)
    .orderBy(desc(textRank), desc(candidates.observedAtMs), asc(candidates.id))
    .limit(args.limit);
  const ranks = denseRanks(rows, (row) => Number(row.textRank));
  return rows.map((row, index) => ({
    lexical: { rank: ranks[index] },
    memory: parseMemoryRow(row.memory),
  }));
}

/** Search active visible records with pgvector cosine distance. */
async function searchVisibleVectorMemories(args: {
  db: MemoryDb;
  embedding: MemoryEmbedding;
  limit: number;
  maxDistance?: number;
  nowMs: number;
  scopes: ResolvedMemoryScope[];
}): Promise<MemoryMatch[]> {
  const predicate = activeVisiblePredicate(args);
  if (!predicate) {
    return [];
  }
  const embedding = args.embedding;
  const distance = cosineDistance(
    juniorMemoryEmbeddings.embedding,
    embedding.vector,
  );
  // Push distance cutoff into SQL so recall does not overfetch weak neighbors.
  const distancePredicate =
    args.maxDistance === undefined
      ? undefined
      : sql`${distance} <= ${args.maxDistance}`;
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
        ...(distancePredicate ? [distancePredicate] : []),
      ),
    )
    .orderBy(
      distance,
      desc(juniorMemoryMemories.createdAtMs),
      asc(juniorMemoryMemories.id),
    )
    .limit(args.limit);
  const ranks = denseRanks(rows, (row) => Number(row.distance));
  return rows.flatMap((row, index) => {
    const distanceValue = Number(row.distance);
    if (
      row.distance === null ||
      !Number.isFinite(distanceValue) ||
      hashEmbeddedContent(row.memory.content) !== row.contentHash
    ) {
      return [];
    }
    return [
      {
        memory: parseMemoryRow(row.memory),
        vector: {
          rank: ranks[index],
        },
      },
    ];
  });
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

  async function reuseDuplicateMemory(args: {
    content: string;
    duplicate: MemoryRecord;
    idempotencyKey?: string;
    nowMs: number;
    scope: ResolvedMemoryScope;
    subject: ResolvedMemorySubject;
  }): Promise<CreateMemoryResult> {
    await rememberDuplicateIdempotency({
      ...args,
      db,
      runtimeContext,
    });
    await storeEmbedding({
      content: args.duplicate.content,
      db,
      embedder,
      memoryId: args.duplicate.id,
      nowMs: args.nowMs,
    });
    return { created: false, memory: args.duplicate };
  }

  /** Persist a memory under the plugin-derived scope and subject. */
  async function createScopedMemory(
    rawInput: CreateMemoryInput,
    subjectType: ResolvedMemorySubject["subjectType"],
  ): Promise<CreateMemoryResult> {
    const input = createMemoryInputSchema.parse(rawInput);
    const nowMs = getNowMs();
    const content = normalizeContent(input.content);
    const scope = deriveMemoryScope(runtimeContext);
    const subject = deriveMemorySubject(runtimeContext, subjectType);
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
          content: idempotent.memory.content,
          db,
          embedder,
          memoryId: idempotent.memory.id,
          nowMs,
        });
        return idempotent.outcome === "created"
          ? { created: false, idempotent: true, memory: idempotent.memory }
          : { created: false, memory: idempotent.memory };
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
      return await reuseDuplicateMemory({
        content,
        duplicate: exactDuplicate,
        idempotencyKey: input.idempotencyKey,
        nowMs,
        scope,
        subject,
      });
    }

    let candidateEmbedding: MemoryEmbedding | undefined;
    if (embedder) {
      try {
        candidateEmbedding = await embedOne(embedder, content);
      } catch {
        candidateEmbedding = undefined;
      }
    }
    let supersededIds: string[] = [];
    if (
      subjectType === "user" &&
      input.kind === "preference" &&
      supersessionDecider &&
      (input.expiresAtMs === undefined || input.expiresAtMs > nowMs)
    ) {
      const preferenceCandidates = await listPreferenceAdjudicationCandidates({
        db,
        ...(candidateEmbedding ? { embedding: candidateEmbedding } : undefined),
        nowMs,
        scope,
        subject,
      });
      const adjudication = await adjudicatePreferenceCandidate({
        candidates: preferenceCandidates,
        content,
        decider: supersessionDecider,
        runtimeContext,
      });
      if (adjudication.decision === "duplicate") {
        return await reuseDuplicateMemory({
          content,
          duplicate: adjudication.memory,
          idempotencyKey: input.idempotencyKey,
          nowMs,
          scope,
          subject,
        });
      }
      if (adjudication.decision === "supersede") {
        supersededIds = adjudication.ids;
      }
    }

    const id = randomUUID();
    const write = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(juniorMemoryMemories)
        .values({
          content,
          createdAtMs: nowMs,
          expiresAtMs: input.expiresAtMs,
          id,
          idempotencyKey: input.idempotencyKey,
          locationId: runtimeContext.locationId,
          observedAtMs: nowMs,
          scope: scope.scope,
          scopeKey: scope.scopeKey,
          sourceKey: sourceKey(runtimeContext),
          sourcePlatform: storedMemorySource(runtimeContext.source),
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
        return { inserted, supersededIds: [] };
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
      return { inserted, supersededIds: idsToClean };
    });
    if (write.inserted[0]) {
      const memory = parseMemoryRow(write.inserted[0]);
      await storeEmbedding({
        content: memory.content,
        db,
        embedder,
        embedding: candidateEmbedding,
        memoryId: memory.id,
        nowMs,
      });
      return {
        created: true,
        memory,
        ...(write.supersededIds.length > 0
          ? { supersededIds: write.supersededIds }
          : undefined),
      };
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
      content: idempotent.memory.content,
      db,
      embedder,
      memoryId: idempotent.memory.id,
      nowMs,
    });
    return idempotent.outcome === "created"
      ? { created: false, idempotent: true, memory: idempotent.memory }
      : { created: false, memory: idempotent.memory };
  }

  /**
   * Hybrid retrieval for both automatic recall and explicit search.
   *
   * Keep both legs parallel and fuse ranks with RRF. Never skip lexical when
   * vectors already hit: that drops exact/token memories and serializes the
   * miss path. Each leg is a hard-capped top-k probe so Postgres work stays
   * bounded even on broad queries.
   *
   * Automatic recall also searches private memory by itself. This keeps newer
   * public memory with common words from hiding older private memory.
   */
  async function retrieveVisibleMemories(
    rawInput: SearchMemoriesInput,
    vectorMaxDistance: number | undefined,
  ): Promise<MemoryRecord[]> {
    const input = searchMemoriesInputSchema.parse(rawInput);
    const nowMs = getNowMs();
    const scopes = deriveVisibleMemoryScopes(runtimeContext);
    await archiveExpiredMemoryBatch({
      db,
      nowMs,
      scopes,
    });
    const limit = boundedLimit(input.limit, DEFAULT_SEARCH_LIMIT);
    const overfetch =
      vectorMaxDistance === undefined
        ? SEARCH_RETRIEVAL_OVERFETCH
        : RECALL_RETRIEVAL_OVERFETCH;
    const candidateLimit = retrievalLegLimit(limit, overfetch);
    const privateScopes = scopes.filter((scope) => scope.scope === "private");
    // Search private memory by itself during recall so public results cannot
    // fill both search windows.
    const probePrivate =
      vectorMaxDistance !== undefined && privateScopes.length > 0;
    const query = normalizeRetrievalQuery(input.query);
    let queryEmbedding: MemoryEmbedding | undefined;
    if (embedder && query) {
      try {
        queryEmbedding = await embedOne(embedder, query);
      } catch {
        queryEmbedding = undefined;
      }
    }
    const emptyMatches = Promise.resolve([] as MemoryMatch[]);
    const lexicalArgs = {
      db,
      limit: candidateLimit,
      nowMs,
      query: input.query,
    };
    // Always run both legs in parallel. Conditional lexical skip is unsafe:
    // one in-threshold vector distractor can hide a stronger lexical hit.
    // Embed once up front; vector probes only run when that embedding exists.
    const matches = await Promise.all([
      queryEmbedding
        ? searchVisibleVectorMemories({
            db,
            embedding: queryEmbedding,
            limit: candidateLimit,
            ...(vectorMaxDistance !== undefined
              ? { maxDistance: vectorMaxDistance }
              : undefined),
            nowMs,
            scopes,
          })
        : emptyMatches,
      searchVisibleLexicalMemories({
        ...lexicalArgs,
        scopes,
      }),
      queryEmbedding && probePrivate
        ? searchVisibleVectorMemories({
            db,
            embedding: queryEmbedding,
            limit: candidateLimit,
            maxDistance: vectorMaxDistance,
            nowMs,
            scopes: privateScopes,
          })
        : emptyMatches,
      probePrivate
        ? searchVisibleLexicalMemories({
            ...lexicalArgs,
            scopes: privateScopes,
          })
        : emptyMatches,
    ]);
    return rankMemoryMatches(matches.flat(), {
      nowMs,
      // Slight lexical preference protects exact ids/names/timezones on ties.
      ...(vectorMaxDistance === undefined
        ? undefined
        : { lexicalWeight: 1, vectorWeight: 0.85 }),
    })
      .slice(0, limit)
      .map(({ memory }) => memory);
  }

  return {
    async archiveExpiredMemories(input) {
      return await archiveExpiredVisibleMemories(input, getNowMs());
    },

    async createMemory(input) {
      return await createScopedMemory(input, "user");
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

    async recallMemories(input) {
      return await retrieveVisibleMemories(input, RECALL_MAX_VECTOR_DISTANCE);
    },

    async searchMemories(input) {
      return await retrieveVisibleMemories(input, undefined);
    },

    async archiveMemory(input) {
      input = archiveMemoryInputSchema.parse(input);
      const nowMs = getNowMs();
      // Public memory is shared and has no single user owner.
      const scopes = deriveVisibleMemoryScopes(runtimeContext).filter(
        (scope) => scope.scope === "private",
      );
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
