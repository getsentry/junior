/**
 * SQL-backed memory store boundary.
 *
 * This module owns row parsing plus visible create/list/search/archive
 * operations. Visibility, expiration, and supersession are enforced before
 * records leave the store.
 */
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  isNull,
  like,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import { z } from "zod";
import * as memorySqlSchema from "./db/schema";
import { juniorMemoryMemories } from "./db/schema";
import {
  MEMORY_SCOPES,
  MEMORY_SOURCE_PLATFORMS,
  MEMORY_SUBJECT_TYPES,
  MEMORY_TYPES,
  memoryRuntimeContextSchema,
  type MemoryRuntimeContext,
  type MemoryScope,
} from "./types";
import {
  deriveMemoryScope,
  deriveMemorySubject,
  deriveVisibleMemoryScopes,
  type ResolvedMemoryScope,
} from "./scope";

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_MEMORY_CONTENT_CHARS = 4_000;

export type MemoryDb = PgDatabase<PgQueryResultHKT, typeof memorySqlSchema>;

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
    type: z.enum(MEMORY_TYPES),
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
    type: z.enum(MEMORY_TYPES),
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
export type MemoryStoreOptions = z.output<typeof memoryStoreOptionsSchema>;

/** Context-bound storage operations for visible long-term memories. */
export interface MemoryStore {
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
    type: parsed.type,
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
  scope: ResolvedMemoryScope;
}): Promise<MemoryRecord | undefined> {
  const rows = await args.db
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
      ),
    )
    .limit(1);
  return rows[0] ? parseMemoryRow(rows[0]) : undefined;
}

function searchScore(memory: MemoryRecord, terms: string[]): number {
  const haystack = memory.content.toLowerCase();
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

/** Create a context-bound SQL-backed store for explicit memory operations. */
export function createMemoryStore(
  db: MemoryDb,
  context: MemoryRuntimeContext,
  options: MemoryStoreOptions = {},
): MemoryStore {
  const runtimeContext = memoryRuntimeContextSchema.parse(context);
  const parsedOptions = memoryStoreOptionsSchema.parse(options);
  const getNowMs = parsedOptions.now ?? Date.now;

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

    const id = `mem_${randomUUID()}`;
    const rows = await db
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
        type: "knowledge",
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
    if (rows[0]) {
      return { created: true, memory: parseMemoryRow(rows[0]) };
    }

    const idempotent = await findByIdempotencyKey({
      db,
      idempotencyKey: input.idempotencyKey,
      scope,
    });
    if (!idempotent) {
      throw new Error("Memory idempotency conflict did not resolve.");
    }
    return { created: false, memory: idempotent };
  }

  return {
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
      const candidates = await searchVisibleMemories({
        db,
        nowMs,
        query: input.query,
        scopes,
      });
      const terms = searchTerms(input.query);
      return candidates
        .map((memory) => ({ memory, score: searchScore(memory, terms) }))
        .filter((item) => item.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            right.memory.createdAtMs - left.memory.createdAtMs ||
            left.memory.id.localeCompare(right.memory.id),
        )
        .slice(0, boundedLimit(input.limit, DEFAULT_SEARCH_LIMIT))
        .map((item) => item.memory);
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
      return parseMemoryRow(updated[0]);
    },
  };
}
