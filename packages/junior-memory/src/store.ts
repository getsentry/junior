/**
 * SQL-backed memory store boundary.
 *
 * This module owns row parsing plus visible create/list/search/archive
 * operations. Visibility, expiration, and supersession are enforced before
 * records leave the store.
 */
import { randomUUID } from "node:crypto";
import type { PluginDb } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  MEMORY_SCOPES,
  MEMORY_SOURCE_PLATFORMS,
  MEMORY_SUBJECT_TYPES,
  MEMORY_TYPES,
  memoryRuntimeContextSchema,
  type MemoryRuntimeContext,
  type MemoryScope,
} from "./types";
import { validateMemoryWritePolicy } from "./policy";
import {
  deriveMemoryScope,
  deriveMemorySubject,
  deriveVisibleMemoryScopes,
  type ResolvedMemoryScope,
} from "./scope";

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_MEMORY_CONTENT_CHARS = 4_000;

const nonEmptyStringSchema = z.string().min(1);
const numberSchema = z.number().finite();
const createMemoryInputSchema = z
  .object({
    content: nonEmptyStringSchema,
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
    id: z.string().min(1),
    scope: z.enum(MEMORY_SCOPES),
    scope_key: z.string().min(1),
    type: z.enum(MEMORY_TYPES),
    subject_type: z.enum(MEMORY_SUBJECT_TYPES),
    subject_key: optionalNonEmptyStringSchema,
    content: z.string().min(1),
    source_platform: z.enum(MEMORY_SOURCE_PLATFORMS),
    source_key: z.string().min(1),
    idempotency_key: optionalStringSchema,
    observed_at_ms: z.coerce.number(),
    created_at_ms: z.coerce.number(),
    expires_at_ms: optionalNumberSchema,
    superseded_at_ms: optionalNumberSchema,
    superseded_by_id: optionalStringSchema,
    archived_at_ms: optionalNumberSchema,
    archive_reason: optionalStringSchema,
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.subject_type === "general") {
      if (row.subject_key !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "General-subject memory rows must not have a subject key.",
          path: ["subject_key"],
        });
      }
      return;
    }
    if (row.subject_key === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "User and conversation memory rows require a subject key.",
        path: ["subject_key"],
      });
    }
  });

const memoryRecordSchema = z
  .object({
    archivedAtMs: numberSchema.optional(),
    archiveReason: nonEmptyStringSchema.optional(),
    content: nonEmptyStringSchema,
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
    subjectType: parsed.subject_type,
    content: parsed.content,
    observedAtMs: parsed.observed_at_ms,
    createdAtMs: parsed.created_at_ms,
    ...(parsed.expires_at_ms !== undefined
      ? { expiresAtMs: parsed.expires_at_ms }
      : {}),
    ...(parsed.superseded_at_ms !== undefined
      ? { supersededAtMs: parsed.superseded_at_ms }
      : {}),
    ...(parsed.superseded_by_id
      ? { supersededById: parsed.superseded_by_id }
      : {}),
    ...(parsed.archived_at_ms !== undefined
      ? { archivedAtMs: parsed.archived_at_ms }
      : {}),
    ...(parsed.archive_reason ? { archiveReason: parsed.archive_reason } : {}),
  });
}

/** Build the scoped SQL predicate and ordered params for visible memory reads. */
function visibleScopePredicate(scopes: ResolvedMemoryScope[]): {
  params: string[];
  sql: string;
} {
  if (scopes.length === 0) {
    return { params: [], sql: "FALSE" };
  }
  const params: string[] = [];
  const clauses = scopes.map((scope) => {
    params.push(scope.scope, scope.scopeKey);
    return `(scope = $${params.length - 1} AND scope_key = $${params.length})`;
  });
  return { params, sql: clauses.join(" OR ") };
}

/** Resolve retry attempts for the same scoped write idempotency key. */
async function findByIdempotencyKey(args: {
  db: PluginDb;
  idempotencyKey: string;
  scope: ResolvedMemoryScope;
}): Promise<MemoryRecord | undefined> {
  const rows = await args.db.query(
    `
SELECT *
FROM junior_memory_memories
WHERE scope = $1
  AND scope_key = $2
  AND idempotency_key = $3
LIMIT 1
`,
    [args.scope.scope, args.scope.scopeKey, args.idempotencyKey],
  );
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
  db: PluginDb;
  limit?: number;
  nowMs: number;
  scopes: ResolvedMemoryScope[];
}): Promise<MemoryRecord[]> {
  const predicate = visibleScopePredicate(args.scopes);
  const limit = boundedLimit(args.limit, DEFAULT_LIST_LIMIT);
  const params: unknown[] = [...predicate.params, args.nowMs, limit];
  const rows = await args.db.query(
    `
SELECT *
FROM junior_memory_memories
WHERE (${predicate.sql})
  AND archived_at_ms IS NULL
  AND superseded_at_ms IS NULL
  AND superseded_by_id IS NULL
  AND (expires_at_ms IS NULL OR expires_at_ms > $${predicate.params.length + 1})
ORDER BY created_at_ms DESC, id ASC
LIMIT $${predicate.params.length + 2}
`,
    params,
  );
  return rows.map(parseMemoryRow);
}

/** Search active visible records with the first-slice lexical matcher. */
async function searchVisibleMemories(args: {
  db: PluginDb;
  nowMs: number;
  query: string;
  scopes: ResolvedMemoryScope[];
}): Promise<MemoryRecord[]> {
  const terms = searchTerms(args.query);
  if (terms.length === 0) {
    return [];
  }
  const predicate = visibleScopePredicate(args.scopes);
  const baseParamCount = predicate.params.length;
  const termClauses = terms.map(
    (_term, index) => `content ILIKE $${baseParamCount + 2 + index}`,
  );
  const rows = await args.db.query(
    `
SELECT *
FROM junior_memory_memories
WHERE (${predicate.sql})
  AND archived_at_ms IS NULL
  AND superseded_at_ms IS NULL
  AND superseded_by_id IS NULL
  AND (expires_at_ms IS NULL OR expires_at_ms > $${baseParamCount + 1})
  AND (${termClauses.join(" OR ")})
`,
    [...predicate.params, args.nowMs, ...terms.map((term) => `%${term}%`)],
  );
  return rows.map(parseMemoryRow);
}

/** Create a context-bound SQL-backed store for explicit memory operations. */
export function createMemoryStore(
  db: PluginDb,
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
    const policy = validateMemoryWritePolicy({
      content,
      subjectType: subject.subjectType,
    });
    if (!policy.ok) {
      throw new Error(policy.reason);
    }
    if (content.length > MAX_MEMORY_CONTENT_CHARS) {
      throw new Error("Memory content exceeds the maximum length.");
    }

    const id = `mem_${randomUUID()}`;
    const rows = await db.query(
      `
INSERT INTO junior_memory_memories (
  id,
  scope,
  scope_key,
  type,
  subject_type,
  subject_key,
  content,
  source_platform,
  source_key,
  idempotency_key,
  observed_at_ms,
  created_at_ms,
  expires_at_ms
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
  $11, $12, $13
)
ON CONFLICT (scope, scope_key, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO NOTHING
RETURNING *
`,
      [
        id,
        scope.scope,
        scope.scopeKey,
        "knowledge",
        subject.subjectType,
        subject.subjectKey,
        content,
        runtimeContext.source.platform,
        sourceKey(runtimeContext),
        input.idempotencyKey,
        nowMs,
        nowMs,
        input.expiresAtMs,
      ],
    );
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
      const predicate = visibleScopePredicate(scopes);
      const idPrefix = input.id.trim();
      if (!idPrefix) {
        throw new Error("Memory id is required.");
      }
      const rows = await db.query(
        `
SELECT *
FROM junior_memory_memories
WHERE (${predicate.sql})
  AND archived_at_ms IS NULL
  AND superseded_at_ms IS NULL
  AND superseded_by_id IS NULL
  AND (expires_at_ms IS NULL OR expires_at_ms > $${predicate.params.length + 1})
  AND (id = $${predicate.params.length + 2} OR id LIKE $${predicate.params.length + 3})
ORDER BY id ASC
LIMIT 2
`,
        [...predicate.params, nowMs, idPrefix, `${idPrefix}%`],
      );
      if (rows.length === 0) {
        throw new Error("Memory was not found in the current context.");
      }
      if (rows.length > 1) {
        throw new Error("Memory id prefix is ambiguous.");
      }
      const memory = parseMemoryRow(rows[0]);
      const updated = await db.query(
        `
UPDATE junior_memory_memories
SET archived_at_ms = $1,
    archive_reason = $2
WHERE id = $3
RETURNING *
`,
        [nowMs, input.reason ?? "user_removed", memory.id],
      );
      return parseMemoryRow(updated[0]);
    },
  };
}
