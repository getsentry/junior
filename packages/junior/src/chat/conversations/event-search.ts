/**
 * Hybrid text search over the event history of one Conversation, across
 * every history version, so a query finds what compaction removed from the
 * model context.
 *
 * Two legs rank the searchable events. Keyword: BM25 over Postgres full-text
 * lexemes, which `event-lexemes.ts` stores after each Turn. An event with no
 * stored lexemes yet gets them computed for the query. Meaning: cosine
 * distance to the event embeddings that `event-embedding.ts` stores after
 * each Turn. Reciprocal rank fusion combines the two ranks, so neither leg
 * needs a score threshold.
 *
 * The caller checks access to the Conversation first.
 */
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import type { SubqueryWithSelection } from "drizzle-orm/pg-core";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationEventEmbeddings,
  juniorConversationEventLexemes,
  juniorConversationEvents,
} from "@/db/schema";
import type { ConversationEmbedder } from "./embedding";
import { lexemesSql, searchedEventTextSql, seqIn } from "./event-lexemes";
import {
  eventExcerpt,
  excerptTerms,
  SEARCHABLE_EVENT_TYPES,
} from "./event-search-text";
import type { ConversationEvent, KnownConversationEventType } from "./history";
import { eventFromRow } from "./sql/history";

// Keyword search computes lexemes for at most this many of the newest events
// without stored ones. On a local Postgres 17 that takes about 3 s for 3,000
// events with 15 MB of text, and about 18 s for 20,000. With stored lexemes,
// the same searches take about 0.2 s and 1.2 s when every event matches.
const MAX_COMPUTED_EVENTS = 20_000;
const CANDIDATES_PER_LEG = 100;
const RECIPROCAL_RANK_FUSION_K = 60;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** One event search. The bounds and types only make the result smaller. */
export interface ConversationEventTextSearch {
  afterSeq?: number;
  beforeSeq?: number;
  conversationId: string;
  /** Embeds the query to also match events by meaning. */
  embedder?: ConversationEmbedder;
  limit: number;
  query: string;
  types?: readonly KnownConversationEventType[];
}

/** One matching event, best match first. */
export interface ConversationEventTextMatch {
  event: ConversationEvent;
  /** Searchable text around the most specific query word. */
  excerpt: string;
}

/** Lexemes that one event shares with the query, with their counts. */
export interface KeywordCandidate {
  /** Distinct lexemes in the event. */
  length: number;
  seq: number;
  termFrequencies: Record<string, number>;
}

/**
 * Rank keyword candidates with Okapi BM25. Document frequencies and the mean
 * length come from the candidates, which are every event that has a query
 * lexeme. Length is the count of distinct lexemes, the size that Postgres
 * stores for a tsvector.
 */
export function rankKeywordCandidates(
  candidates: readonly KeywordCandidate[],
  searchedEvents: number,
): number[] {
  if (candidates.length === 0) return [];
  const documentFrequency = new Map<string, number>();
  for (const candidate of candidates) {
    for (const term of Object.keys(candidate.termFrequencies)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const total = Math.max(searchedEvents, candidates.length);
  const meanLength =
    candidates.reduce((sum, candidate) => sum + candidate.length, 0) /
    candidates.length;
  const score = (candidate: KeywordCandidate) =>
    Object.entries(candidate.termFrequencies).reduce((sum, [term, tf]) => {
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const norm =
        BM25_K1 *
        (1 - BM25_B + (BM25_B * candidate.length) / (meanLength || 1));
      return sum + (idf * tf * (BM25_K1 + 1)) / (tf + norm);
    }, 0);
  return candidates
    .map((candidate) => ({ seq: candidate.seq, score: score(candidate) }))
    .sort((left, right) => right.score - left.score || right.seq - left.seq)
    .map(({ seq }) => seq);
}

/**
 * Fuse ranked event lists with reciprocal rank fusion. An event in both
 * lists ranks above an event in one. Ties go to the newer event.
 */
export function fuseEventRanks(
  lists: readonly (readonly number[])[],
): number[] {
  const scores = new Map<number, number>();
  for (const list of lists) {
    list.forEach((seq, index) => {
      scores.set(
        seq,
        (scores.get(seq) ?? 0) + 1 / (RECIPROCAL_RANK_FUSION_K + index + 1),
      );
    });
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || right[0] - left[0])
    .map(([seq]) => seq);
}

function searchBounds(
  search: ConversationEventTextSearch,
  types: readonly string[],
): SQL | undefined {
  const events = juniorConversationEvents;
  return and(
    eq(events.conversationId, search.conversationId),
    inArray(events.type, [...types]),
    search.afterSeq === undefined ? undefined : gt(events.seq, search.afterSeq),
    search.beforeSeq === undefined
      ? undefined
      : lt(events.seq, search.beforeSeq),
  );
}

async function keywordRanks(
  db: JuniorDatabase,
  search: ConversationEventTextSearch,
  bounds: SQL | undefined,
): Promise<number[]> {
  const events = juniorConversationEvents;
  const stored = juniorConversationEventLexemes;
  const storedRow = and(
    eq(stored.conversationId, events.conversationId),
    eq(stored.seq, events.seq),
  );
  const queryVector = lexemesSql(search.query);
  // Any query lexeme matches. BM25 ranks events with more and rarer ones first.
  // The text form of a stripped tsvector is its quoted lexemes with one space
  // between them, so joining them with ` | ` gives an OR query. Each function
  // is immutable, so Postgres folds the query to a constant at plan time and
  // can choose the GIN index for rare words. A subquery would hide it.
  const tsquery = sql`regexp_replace(strip(${queryVector})::text, ''' ''', ''' | ''', 'g')::tsquery`;
  const storedDocuments = db
    .select({
      seq: events.seq,
      searchVector: sql`${stored.lexemes}`.as("search_vector"),
    })
    .from(stored)
    .innerJoin(events, storedRow)
    .where(and(bounds, sql`${stored.lexemes} @@ ${tsquery}`))
    .as("stored_events");
  // Events without stored lexemes get them for this query, newest first.
  const unstored = await db
    .select({ seq: events.seq })
    .from(events)
    .leftJoin(stored, storedRow)
    .where(and(bounds, isNull(stored.seq)))
    .orderBy(desc(events.seq))
    .limit(MAX_COMPUTED_EVENTS);
  // The limit keeps Postgres from inlining the subquery, so it computes the
  // lexemes of each event once.
  const computedDocuments = db
    .select({
      seq: events.seq,
      searchVector: sql`${lexemesSql(searchedEventTextSql())}`.as(
        "search_vector",
      ),
    })
    .from(events)
    .where(
      and(
        eq(events.conversationId, search.conversationId),
        seqIn(unstored.map((row) => row.seq)),
      ),
    )
    .limit(MAX_COMPUTED_EVENTS)
    .as("computed_events");
  const [storedCandidates, computedCandidates, [searched]] = await Promise.all([
    keywordCandidates(db, storedDocuments, queryVector),
    unstored.length === 0
      ? []
      : keywordCandidates(db, computedDocuments, queryVector, tsquery),
    db.select({ total: count() }).from(events).where(bounds),
  ]);
  return rankKeywordCandidates(
    [...storedCandidates, ...computedCandidates],
    searched?.total ?? 0,
  ).slice(0, CANDIDATES_PER_LEG);
}

async function keywordCandidates(
  db: JuniorDatabase,
  documents: SubqueryWithSelection<
    {
      seq: typeof juniorConversationEvents.seq;
      searchVector: SQL.Aliased<unknown>;
    },
    string
  >,
  queryVector: SQL,
  tsquery?: SQL,
): Promise<KeywordCandidate[]> {
  const rows = await db
    .select({
      seq: documents.seq,
      length: sql<number>`length(${documents.searchVector})`,
      // Marking the query lexemes and keeping only those is far cheaper than
      // unnesting every lexeme of a long event.
      termFrequencies: sql<Record<string, number>>`(
        SELECT coalesce(jsonb_object_agg(lexeme, coalesce(cardinality(positions), 1)), '{}'::jsonb)
        FROM unnest(ts_filter(setweight(${documents.searchVector}, 'A', tsvector_to_array(${queryVector})), '{a}'))
      )`,
    })
    .from(documents)
    .where(tsquery ? sql`${documents.searchVector} @@ ${tsquery}` : undefined);
  return rows.map((row) => ({ ...row, length: Number(row.length) }));
}

async function meaningRanks(
  db: JuniorDatabase,
  search: ConversationEventTextSearch,
  bounds: SQL | undefined,
): Promise<number[]> {
  if (!search.embedder) return [];
  const query = await search.embedder({
    inputType: "query",
    text: search.query,
  });
  const events = juniorConversationEvents;
  const embeddings = juniorConversationEventEmbeddings;
  const rows = await db
    .select({ seq: embeddings.seq })
    .from(embeddings)
    .innerJoin(
      events,
      and(
        eq(events.conversationId, embeddings.conversationId),
        eq(events.seq, embeddings.seq),
      ),
    )
    .where(
      and(
        bounds,
        eq(embeddings.provider, query.provider),
        eq(embeddings.model, query.model),
        eq(embeddings.dimensions, query.vector.length),
      ),
    )
    // Postgres can order before it filters, and pgvector fails on vectors of
    // two sizes. The CASE keeps a vector of another size from the operator.
    .orderBy(
      sql`CASE WHEN ${embeddings.dimensions} = ${query.vector.length} THEN ${embeddings.embedding} <=> ${JSON.stringify(query.vector)}::halfvec END`,
    )
    .limit(CANDIDATES_PER_LEG);
  return rows.map((row) => row.seq);
}

/** Search the event text of one Conversation. Best match first. */
export async function searchConversationEventText(
  db: JuniorDatabase,
  search: ConversationEventTextSearch,
): Promise<ConversationEventTextMatch[]> {
  const types = SEARCHABLE_EVENT_TYPES.filter(
    (type) => !search.types || search.types.includes(type),
  );
  if (types.length === 0) return [];
  const bounds = searchBounds(search, types);
  const ranks = await Promise.all([
    keywordRanks(db, search, bounds),
    meaningRanks(db, search, bounds),
  ]);
  const seqs = fuseEventRanks(ranks).slice(0, search.limit);
  if (seqs.length === 0) return [];
  const events = juniorConversationEvents;
  const rows = await db
    .select({
      row: events,
      text: searchedEventTextSql(),
    })
    .from(events)
    .where(
      and(
        eq(events.conversationId, search.conversationId),
        inArray(events.seq, seqs),
      ),
    );
  const bySeq = new Map(rows.map((row) => [row.row.seq, row]));
  const terms = excerptTerms(search.query);
  return seqs.flatMap((seq) => {
    const match = bySeq.get(seq);
    return match
      ? [
          {
            event: eventFromRow(match.row),
            excerpt: eventExcerpt(match.text ?? "", terms),
          },
        ]
      : [];
  });
}
