/**
 * Memory creation owns access, idempotency, exact duplicates, and preference
 * replacement. It adds the embedding after commit. An embedding failure does
 * not roll back the memory.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { cosineDistance } from "drizzle-orm/sql/functions";
import { z } from "zod";
import { getSourceKey } from "@sentry/junior-plugin-api";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import {
  EMBEDDING_METRIC,
  embedMemoryText,
  hashEmbeddedContent,
  normalizeMemoryContent,
  storeMemoryEmbedding,
  type MemoryEmbedding,
  type MemoryEmbeddingProvider,
} from "./embeddings";
import {
  archiveExpiredMemoryBatch,
  parseMemoryRow,
  type MemoryDb,
  type Memory,
} from "./memories";
import {
  deriveMemoryScope,
  deriveMemorySubject,
  type ResolvedMemoryScope,
  type ResolvedMemorySubject,
} from "./scope";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_KINDS,
  memoryRuntimeContextSchema,
  type MemoryRuntimeContext,
} from "./types";

const PREFERENCE_ADJUDICATION_CANDIDATE_LIMIT = 10;
const PREFERENCE_ADJUDICATION_VECTOR_LIMIT = 5;
const MAX_MEMORY_CONTENT_CHARS = 4_000;

const nonEmptyStringSchema = z.string().min(1);
const numberSchema = z.number().finite();
const memoryContentSchema = z
  .string()
  .refine((content) => content.trim().length > 0, {
    message: "Memory content is required.",
  });
const createMemoryInputSchema = z
  .object({
    content: memoryContentSchema,
    expiresAtMs: z.number().finite().optional(),
    idempotencyKey: nonEmptyStringSchema,
    kind: z.enum(MEMORY_KINDS),
  })
  .strict();
const memorySupersessionCandidateSchema = z
  .object({ content: z.string().min(1), id: z.string().min(1) })
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
      .object({ content: z.string().min(1), kind: z.literal("preference") })
      .strict(),
    existingMemories: memorySupersessionCandidatesSchema,
    runtimeContext: memoryRuntimeContextSchema,
  })
  .strict();

/** Validated preference decision limited to supplied existing memories. */
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
    z.object({ decision: z.enum(["distinct", "uncertain"]) }).strict(),
  ],
);

export type CreateMemoryInput = z.output<typeof createMemoryInputSchema>;
export interface CreateMemoryResult {
  created: boolean;
  /** True when this call found the memory written for the same input identity. */
  idempotent?: true;
  memory: Memory;
  /** Memory ids made inactive by this write. */
  supersededIds?: string[];
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

function sourceKey(ctx: MemoryRuntimeContext): string {
  const key = getSourceKey(ctx.source);
  if (!key) {
    throw new Error("Memory Source has no stable key.");
  }
  return key;
}

function activeScopedSubjectPredicate(args: {
  kind: Memory["kind"];
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

type IdempotencyMatch = {
  memory: Memory;
  outcome: "created" | "duplicate";
};

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

  const aliases = await args.db
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
  for (const alias of aliases) {
    if (!alias.supersededById) continue;
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

async function findExactDuplicate(args: {
  content: string;
  db: MemoryDb;
  kind: Memory["kind"];
  nowMs: number;
  scope: ResolvedMemoryScope;
  subject: ResolvedMemorySubject;
}): Promise<Memory | undefined> {
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
  duplicate: Memory;
  idempotencyKey: string;
  nowMs: number;
  runtimeContext: MemoryRuntimeContext;
  scope: ResolvedMemoryScope;
  subject: ResolvedMemorySubject;
}): Promise<void> {
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
      sourcePlatform: args.runtimeContext.source.platform,
      subjectKey: args.subject.subjectKey,
      subjectType: args.subject.subjectType,
      supersededAtMs: args.nowMs,
      supersededById: args.duplicate.id,
      kind: args.duplicate.kind,
    })
    .onConflictDoNothing();
}

async function listVectorPreferenceCandidates(args: {
  db: MemoryDb;
  embedding: MemoryEmbedding;
  nowMs: number;
  scope: ResolvedMemoryScope;
  subject: ResolvedMemorySubject;
}): Promise<Memory[]> {
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
  return rows.flatMap((row) =>
    hashEmbeddedContent(row.memory.content) === row.contentHash
      ? [parseMemoryRow(row.memory)]
      : [],
  );
}

/** Find vector matches, then fill the candidate limit with recent memories. */
async function listPreferenceCandidates(args: {
  db: MemoryDb;
  embedding: MemoryEmbedding | undefined;
  nowMs: number;
  scope: ResolvedMemoryScope;
  subject: ResolvedMemorySubject;
}): Promise<Memory[]> {
  const vector = args.embedding
    ? await listVectorPreferenceCandidates({
        ...args,
        embedding: args.embedding,
      })
    : [];
  const recent = (
    await args.db
      .select()
      .from(juniorMemoryMemories)
      .where(activeScopedSubjectPredicate({ ...args, kind: "preference" }))
      .orderBy(
        desc(juniorMemoryMemories.createdAtMs),
        asc(juniorMemoryMemories.id),
      )
      .limit(PREFERENCE_ADJUDICATION_CANDIDATE_LIMIT)
  ).map(parseMemoryRow);
  return [
    ...new Map(
      [...vector, ...recent].map((memory) => [memory.id, memory]),
    ).values(),
  ].slice(0, PREFERENCE_ADJUDICATION_CANDIDATE_LIMIT);
}

type PreferenceDecision =
  | { decision: "create" }
  | { decision: "duplicate"; memory: Memory }
  | { decision: "supersede"; ids: [string, ...string[]] };

/** Keep old memories active when the model fails or returns unknown ids. */
async function adjudicatePreference(args: {
  candidates: Memory[];
  content: string;
  decider: MemorySupersessionDecider;
  runtimeContext: MemoryRuntimeContext;
}): Promise<PreferenceDecision> {
  if (!args.candidates[0]) return { decision: "create" };
  const candidateIds = new Set(args.candidates.map(({ id }) => id));
  try {
    const decision = await args.decider.adjudicateSupersession({
      candidate: { content: args.content, kind: "preference" },
      existingMemories: args.candidates.map(({ content, id }) => ({
        content,
        id,
      })),
      runtimeContext: args.runtimeContext,
    });
    if (decision.decision === "duplicate") {
      const memory = args.candidates.find(
        ({ id }) => id === decision.duplicateId,
      );
      return memory
        ? { decision: "duplicate", memory }
        : { decision: "create" };
    }
    if (decision.decision === "supersedes_old") {
      const ids = decision.supersededIds.filter((id) => candidateIds.has(id));
      const [first, ...rest] = ids;
      return first
        ? { decision: "supersede", ids: [first, ...rest] }
        : { decision: "create" };
    }
  } catch {
    return { decision: "create" };
  }
  return { decision: "create" };
}

/** Create one memory with runtime-owned scope and subject authority. */
export async function createMemory(args: {
  context: MemoryRuntimeContext;
  db: MemoryDb;
  embedder?: MemoryEmbeddingProvider;
  input: CreateMemoryInput;
  now?: () => number;
  subjectType: ResolvedMemorySubject["subjectType"];
  supersessionDecider?: MemorySupersessionDecider;
}): Promise<CreateMemoryResult> {
  const context = memoryRuntimeContextSchema.parse(args.context);
  const input = createMemoryInputSchema.parse(args.input);
  const nowMs = numberSchema.parse(args.now?.() ?? Date.now());
  const content = normalizeMemoryContent(input.content);
  const scope = deriveMemoryScope(context);
  const subject = deriveMemorySubject(context, args.subjectType);
  if (content.length > MAX_MEMORY_CONTENT_CHARS) {
    throw new Error("Memory content exceeds the maximum length.");
  }
  await archiveExpiredMemoryBatch({ db: args.db, nowMs, scopes: [scope] });
  await archiveExpiredMemoryBatch({
    db: args.db,
    idempotencyKey: input.idempotencyKey,
    limit: 1,
    nowMs,
    scopes: [scope],
  });

  const reuse = async (duplicate: Memory): Promise<CreateMemoryResult> => {
    await rememberDuplicateIdempotency({
      content,
      db: args.db,
      duplicate,
      idempotencyKey: input.idempotencyKey,
      nowMs,
      runtimeContext: context,
      scope,
      subject,
    });
    await storeMemoryEmbedding({
      content: duplicate.content,
      db: args.db,
      embedder: args.embedder,
      memoryId: duplicate.id,
      nowMs,
    });
    return { created: false, memory: duplicate };
  };

  const idempotent = await findByIdempotencyKey({
    db: args.db,
    idempotencyKey: input.idempotencyKey,
    nowMs,
    scope,
  });
  if (idempotent) {
    await storeMemoryEmbedding({
      content: idempotent.memory.content,
      db: args.db,
      embedder: args.embedder,
      memoryId: idempotent.memory.id,
      nowMs,
    });
    return idempotent.outcome === "created"
      ? { created: false, idempotent: true, memory: idempotent.memory }
      : { created: false, memory: idempotent.memory };
  }

  const exactDuplicate = await findExactDuplicate({
    content,
    db: args.db,
    kind: input.kind,
    nowMs,
    scope,
    subject,
  });
  if (exactDuplicate) return await reuse(exactDuplicate);

  let candidateEmbedding: MemoryEmbedding | undefined;
  if (args.embedder) {
    try {
      candidateEmbedding = await embedMemoryText(args.embedder, content);
    } catch {
      candidateEmbedding = undefined;
    }
  }
  let supersededIds: string[] = [];
  if (
    args.subjectType === "user" &&
    input.kind === "preference" &&
    args.supersessionDecider &&
    (input.expiresAtMs === undefined || input.expiresAtMs > nowMs)
  ) {
    const candidates = await listPreferenceCandidates({
      db: args.db,
      embedding: candidateEmbedding,
      nowMs,
      scope,
      subject,
    });
    const decision = await adjudicatePreference({
      candidates,
      content,
      decider: args.supersessionDecider,
      runtimeContext: context,
    });
    if (decision.decision === "duplicate") return await reuse(decision.memory);
    if (decision.decision === "supersede") supersededIds = decision.ids;
  }

  const id = randomUUID();
  const write = await args.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(juniorMemoryMemories)
      .values({
        content,
        createdAtMs: nowMs,
        expiresAtMs: input.expiresAtMs,
        id,
        idempotencyKey: input.idempotencyKey,
        locationId: context.locationId,
        observedAtMs: nowMs,
        scope: scope.scope,
        scopeKey: scope.scopeKey,
        sourceKey: sourceKey(context),
        sourcePlatform: context.source.platform,
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
      .set({ supersededAtMs: nowMs, supersededById: insertedMemory.id })
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
    const idsToClean = superseded.map(({ id }) => id);
    if (idsToClean.length > 0) {
      await tx
        .delete(juniorMemoryEmbeddings)
        .where(inArray(juniorMemoryEmbeddings.memoryId, idsToClean));
    }
    return { inserted, supersededIds: idsToClean };
  });
  if (write.inserted[0]) {
    const memory = parseMemoryRow(write.inserted[0]);
    await storeMemoryEmbedding({
      content: memory.content,
      db: args.db,
      embedder: args.embedder,
      embedding: candidateEmbedding,
      memoryId: memory.id,
      nowMs,
    });
    const result: CreateMemoryResult = {
      created: true,
      memory,
    };
    if (write.supersededIds.length > 0) {
      result.supersededIds = write.supersededIds;
    }
    return result;
  }
  const conflict = await findByIdempotencyKey({
    db: args.db,
    idempotencyKey: input.idempotencyKey,
    nowMs,
    scope,
  });
  if (!conflict) {
    throw new Error("Memory idempotency conflict did not resolve.");
  }
  await storeMemoryEmbedding({
    content: conflict.memory.content,
    db: args.db,
    embedder: args.embedder,
    memoryId: conflict.memory.id,
    nowMs,
  });
  return conflict.outcome === "created"
    ? { created: false, idempotent: true, memory: conflict.memory }
    : { created: false, memory: conflict.memory };
}
