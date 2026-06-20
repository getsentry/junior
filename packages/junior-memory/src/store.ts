/**
 * SQL-backed memory store boundary.
 *
 * This module owns row parsing plus visible create/list/search/archive
 * operations. Visibility, expiration, and supersession are enforced before
 * records leave the store.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PluginDb } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  MEMORY_SCOPES,
  MEMORY_SENSITIVITIES,
  MEMORY_TYPES,
  type MemoryRecord,
  type MemoryRuntimeContext,
  type MemoryScope,
  type MemorySensitivity,
  type MemoryType,
} from "./types";
import { validateMemoryWritePolicy } from "./policy";
import {
  deriveMemoryScope,
  deriveVisibleMemoryScopes,
  type ResolvedMemoryScope,
} from "./scope";

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_MEMORY_CONTENT_CHARS = 4_000;

const optionalNumberSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.coerce.number().optional(),
);
const optionalStringSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional(),
);
const memoryRowSchema = z
  .object({
    id: z.string().min(1),
    scope: z.enum(MEMORY_SCOPES),
    scope_key: z.string().min(1),
    type: z.enum(MEMORY_TYPES),
    sensitivity: z.enum(MEMORY_SENSITIVITIES),
    content: z.string().min(1),
    content_hash: z.string().min(1),
    source_platform: z.enum(["slack", "local"]),
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
  .strict();

interface MemoryRow {
  archived_at_ms?: number;
  archive_reason?: string;
  content: string;
  content_hash: string;
  created_at_ms: number;
  expires_at_ms?: number;
  id: string;
  idempotency_key?: string;
  observed_at_ms: number;
  scope: MemoryScope;
  scope_key: string;
  sensitivity: MemorySensitivity;
  source_key: string;
  source_platform: "slack" | "local";
  superseded_at_ms?: number;
  superseded_by_id?: string;
  type: MemoryType;
}

export type CreateMemoryInput = MemoryRuntimeContext & {
  content: string;
  expiresAtMs?: number;
  idempotencyKey?: string;
  nowMs?: number;
  observedAtMs?: number;
  scope?: MemoryScope;
  sensitivity?: MemorySensitivity;
  type?: MemoryType;
};

export interface CreateMemoryResult {
  created: boolean;
  memory: MemoryRecord;
}

export type ListMemoriesInput = MemoryRuntimeContext & {
  limit?: number;
  nowMs?: number;
};

export type SearchMemoriesInput = MemoryRuntimeContext & {
  limit?: number;
  nowMs?: number;
  query: string;
};

export type ArchiveMemoryInput = MemoryRuntimeContext & {
  id: string;
  nowMs?: number;
  reason?: string;
};

export interface MemoryStore {
  archiveMemory(input: ArchiveMemoryInput): Promise<MemoryRecord>;
  createMemory(input: CreateMemoryInput): Promise<CreateMemoryResult>;
  listMemories(input: ListMemoriesInput): Promise<MemoryRecord[]>;
  searchMemories(input: SearchMemoriesInput): Promise<MemoryRecord[]>;
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function contentHash(content: string): string {
  return createHash("sha256")
    .update(normalizeContent(content).toLowerCase())
    .digest("hex");
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

function parseMemoryRow(row: unknown): MemoryRecord {
  const parsed = memoryRowSchema.parse(row) as MemoryRow;
  return {
    id: parsed.id,
    scope: parsed.scope,
    scopeKey: parsed.scope_key,
    type: parsed.type,
    sensitivity: parsed.sensitivity,
    content: parsed.content,
    contentHash: parsed.content_hash,
    sourcePlatform: parsed.source_platform,
    sourceKey: parsed.source_key,
    ...(parsed.idempotency_key
      ? { idempotencyKey: parsed.idempotency_key }
      : {}),
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
  };
}

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

async function findActiveDuplicate(args: {
  db: PluginDb;
  hash: string;
  scope: ResolvedMemoryScope;
  nowMs: number;
}): Promise<MemoryRecord | undefined> {
  const rows = await args.db.query(
    `
SELECT *
FROM junior_memory_memories
WHERE scope = $1
  AND scope_key = $2
  AND content_hash = $3
  AND archived_at_ms IS NULL
  AND superseded_at_ms IS NULL
  AND superseded_by_id IS NULL
  AND (expires_at_ms IS NULL OR expires_at_ms > $4)
ORDER BY created_at_ms DESC
LIMIT 1
`,
    [args.scope.scope, args.scope.scopeKey, args.hash, args.nowMs],
  );
  return rows[0] ? parseMemoryRow(rows[0]) : undefined;
}

/** Archive expired matching rows so recreated content can become active again. */
async function archiveExpiredDuplicates(args: {
  db: PluginDb;
  hash: string;
  nowMs: number;
  scope: ResolvedMemoryScope;
}): Promise<void> {
  await args.db.query(
    `
UPDATE junior_memory_memories
SET archived_at_ms = $1,
    archive_reason = 'expired'
WHERE scope = $2
  AND scope_key = $3
  AND content_hash = $4
  AND archived_at_ms IS NULL
  AND superseded_at_ms IS NULL
  AND superseded_by_id IS NULL
  AND expires_at_ms IS NOT NULL
  AND expires_at_ms <= $1
`,
    [args.nowMs, args.scope.scope, args.scope.scopeKey, args.hash],
  );
}

async function findByIdempotencyKey(args: {
  db: PluginDb;
  idempotencyKey: string | undefined;
  scope: ResolvedMemoryScope;
}): Promise<MemoryRecord | undefined> {
  if (!args.idempotencyKey) {
    return undefined;
  }
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

/** Create the SQL-backed store for explicit memory operations. */
export function createMemoryStore(db: PluginDb): MemoryStore {
  return {
    async createMemory(input) {
      const nowMs = input.nowMs ?? Date.now();
      const content = normalizeContent(input.content);
      const scope = deriveMemoryScope(input, input.scope ?? "personal");
      const sensitivity = input.sensitivity ?? "public";
      const policy = validateMemoryWritePolicy({
        content,
        scope: scope.scope,
        sensitivity,
      });
      if (!policy.ok) {
        throw new Error(policy.reason);
      }
      if (content.length > MAX_MEMORY_CONTENT_CHARS) {
        throw new Error("Memory content exceeds the maximum length.");
      }

      const hash = contentHash(content);
      const idempotent = await findByIdempotencyKey({
        db,
        idempotencyKey: input.idempotencyKey,
        scope,
      });
      if (idempotent) {
        return { created: false, memory: idempotent };
      }
      await archiveExpiredDuplicates({ db, hash, nowMs, scope });
      const existing = await findActiveDuplicate({ db, hash, scope, nowMs });
      if (existing) {
        return { created: false, memory: existing };
      }

      const id = `mem_${randomUUID()}`;
      const rows = await db.query(
        `
INSERT INTO junior_memory_memories (
  id,
  scope,
  scope_key,
  type,
  sensitivity,
  content,
  content_hash,
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
RETURNING *
`,
        [
          id,
          scope.scope,
          scope.scopeKey,
          input.type ?? "knowledge",
          sensitivity,
          content,
          hash,
          input.source.platform,
          sourceKey(input),
          input.idempotencyKey,
          input.observedAtMs ?? nowMs,
          nowMs,
          input.expiresAtMs,
        ],
      );
      return { created: true, memory: parseMemoryRow(rows[0]) };
    },

    async listMemories(input) {
      const nowMs = input.nowMs ?? Date.now();
      const scopes = deriveVisibleMemoryScopes(input);
      return await listVisibleMemories({
        db,
        limit: input.limit,
        nowMs,
        scopes,
      });
    },

    async searchMemories(input) {
      const nowMs = input.nowMs ?? Date.now();
      const scopes = deriveVisibleMemoryScopes(input);
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
      const nowMs = input.nowMs ?? Date.now();
      const scopes = deriveVisibleMemoryScopes(input);
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
