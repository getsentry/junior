/**
 * Search text and vectors in parallel. Automatic recall also gives private
 * memory a separate result window so public results cannot fill both windows.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm/sql/functions";
import { z } from "zod";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import {
  EMBEDDING_METRIC,
  embedMemoryText,
  hashEmbeddedContent,
  type MemoryEmbedding,
  type MemoryEmbeddingProvider,
} from "./embeddings";
import {
  activeVisiblePredicate,
  archiveExpiredMemoryBatch,
  parseMemoryRow,
  type MemoryDb,
  type Memory,
} from "./memories";
import { rankMemoryMatches, type MemoryMatch } from "./ranking";
import { deriveVisibleMemoryScopes, type ResolvedMemoryScope } from "./scope";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  memoryRuntimeContextSchema,
  type MemoryRuntimeContext,
} from "./types";

const DEFAULT_SEARCH_LIMIT = 10;
const SEARCH_RETRIEVAL_OVERFETCH = 4;
const RECALL_RETRIEVAL_OVERFETCH = 2;
const MAX_RETRIEVAL_LEG_CANDIDATES = 200;
const MAX_LEXICAL_RANK_CANDIDATES = 200;
const LEXICAL_RANK_WINDOW_MULTIPLIER = 4;
const MAX_RETRIEVAL_QUERY_CHARS = 1_500;
const RECALL_MAX_VECTOR_DISTANCE = 0.45;
const numberSchema = z.number().finite();

const retrieveMemoriesInputSchema = z
  .object({
    limit: z.number().finite().optional(),
    query: z.string().min(1),
  })
  .strict();
type RetrieveMemoriesInput = z.output<typeof retrieveMemoriesInputSchema>;

function boundedLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(200, Math.max(1, Math.floor(value)));
}

function normalizeQuery(query: string): string {
  const normalized = query.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_RETRIEVAL_QUERY_CHARS
    ? normalized
    : normalized.slice(0, MAX_RETRIEVAL_QUERY_CHARS).trimEnd();
}

function retrievalLegLimit(limit: number, overfetch: number): number {
  const requested = Math.max(1, limit);
  return Math.min(
    MAX_RETRIEVAL_LEG_CANDIDATES,
    Math.max(requested, requested * Math.max(1, overfetch)),
  );
}

function denseRanks<T>(values: T[], key: (value: T) => string | number) {
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

async function searchLexical(args: {
  db: MemoryDb;
  limit: number;
  nowMs: number;
  query: string;
  scopes: ResolvedMemoryScope[];
}): Promise<MemoryMatch[]> {
  const predicate = activeVisiblePredicate(args);
  const query = normalizeQuery(args.query);
  if (!predicate || !query) return [];
  const queryVector = sql`to_tsvector('english', ${query})`;
  const tsquery = sql`(
    SELECT COALESCE(
      string_agg(quote_literal(term), ' | ')::tsquery,
      ''::tsquery
    )
    FROM unnest(tsvector_to_array(${queryVector})) AS query_terms(term)
  )`;
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

async function searchVector(args: {
  db: MemoryDb;
  embedding: MemoryEmbedding;
  limit: number;
  maxDistance: number | undefined;
  nowMs: number;
  scopes: ResolvedMemoryScope[];
}): Promise<MemoryMatch[]> {
  const predicate = activeVisiblePredicate(args);
  if (!predicate) return [];
  const distance = cosineDistance(
    juniorMemoryEmbeddings.embedding,
    args.embedding.vector,
  );
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
        eq(juniorMemoryEmbeddings.provider, args.embedding.provider),
        eq(juniorMemoryEmbeddings.model, args.embedding.model),
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
        vector: { rank: ranks[index] },
      },
    ];
  });
}

/** Retrieve active memories with search or recall ranking rules. */
export async function retrieveMemories(args: {
  context: MemoryRuntimeContext;
  db: MemoryDb;
  embedder?: MemoryEmbeddingProvider;
  input: RetrieveMemoriesInput;
  mode: "recall" | "search";
  now?: () => number;
}): Promise<Memory[]> {
  const context = memoryRuntimeContextSchema.parse(args.context);
  const input = retrieveMemoriesInputSchema.parse(args.input);
  const nowMs = numberSchema.parse(args.now?.() ?? Date.now());
  const scopes = deriveVisibleMemoryScopes(context);
  await archiveExpiredMemoryBatch({ db: args.db, nowMs, scopes });
  const limit = boundedLimit(input.limit, DEFAULT_SEARCH_LIMIT);
  const recall = args.mode === "recall";
  const candidateLimit = retrievalLegLimit(
    limit,
    recall ? RECALL_RETRIEVAL_OVERFETCH : SEARCH_RETRIEVAL_OVERFETCH,
  );
  const privateScopes = scopes.filter((scope) => scope.scope === "private");
  const probePrivate = recall && privateScopes.length > 0;
  const query = normalizeQuery(input.query);
  let queryEmbedding: MemoryEmbedding | undefined;
  if (args.embedder && query) {
    try {
      queryEmbedding = await embedMemoryText(args.embedder, query);
    } catch {
      queryEmbedding = undefined;
    }
  }
  const empty = Promise.resolve([] as MemoryMatch[]);
  const lexicalArgs = {
    db: args.db,
    limit: candidateLimit,
    nowMs,
    query: input.query,
  };
  const matches = await Promise.all([
    queryEmbedding
      ? searchVector({
          db: args.db,
          embedding: queryEmbedding,
          limit: candidateLimit,
          maxDistance: recall ? RECALL_MAX_VECTOR_DISTANCE : undefined,
          nowMs,
          scopes,
        })
      : empty,
    searchLexical({ ...lexicalArgs, scopes }),
    queryEmbedding && probePrivate
      ? searchVector({
          db: args.db,
          embedding: queryEmbedding,
          limit: candidateLimit,
          maxDistance: RECALL_MAX_VECTOR_DISTANCE,
          nowMs,
          scopes: privateScopes,
        })
      : empty,
    probePrivate
      ? searchLexical({ ...lexicalArgs, scopes: privateScopes })
      : empty,
  ]);
  const weights = recall
    ? { lexicalWeight: 1, nowMs, vectorWeight: 0.85 }
    : { nowMs };
  return rankMemoryMatches(matches.flat(), weights)
    .slice(0, limit)
    .map(({ memory }) => memory);
}
