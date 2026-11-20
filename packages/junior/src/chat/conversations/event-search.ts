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
 * The agent's tool calls count half in the fusion, so what a tool returned
 * ranks above the call that repeats the query's words. The input of the
 * running Turn is not a result: it is in the model context already.
 *
 * The caller checks access to the Conversation first.
 *
 * Attributes on the `searchConversationEvents` `gen_ai.execute_tool` span:
 * - `app.event_search.keyword.candidate.count`: events with a query lexeme.
 * - `app.event_search.keyword.computed.count`: events whose lexemes were
 *   computed for this query because none were stored yet.
 * - `app.event_search.keyword_ms`, `app.event_search.meaning_ms`: time of
 *   each leg, which run at the same time.
 * - `app.event_search.meaning.candidate.count`: events with a vector.
 * - `app.event_search.meaning.top_distance`: cosine distance of the nearest
 *   event, to tune a similarity floor.
 * - `app.event_search.result.count`: events returned.
 * - `app.event_search.result.<kind>.count`, `app.event_search.top5.<kind>.count`:
 *   returned events, and the first 5, by kind: `tool_call`, `tool_result`,
 *   `user_message`, `assistant_message`, or `message` (a Conversation
 *   Message).
 * - `app.event_search.result.current_turn.count`,
 *   `app.event_search.top5.current_turn.count`: of those, events from the
 *   running Turn. Set only when the search knows the running Turn.
 * Without an embedder, the meaning attributes are not set. Without results,
 * the kind attributes are not set.
 * Policy: policies/observability.md.
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
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { SubqueryWithSelection } from "drizzle-orm/pg-core";
import {
  bm25InverseDocumentFrequency,
  bm25NormalizedFrequency,
  bm25Saturation,
  fuseRankedLists,
} from "@sentry/junior-search";
import type { JuniorDatabase } from "@/db/db";
import { setSpanAttributes } from "@/chat/logging";
import {
  juniorConversationEventEmbeddings,
  juniorConversationEventLexemes,
  juniorConversationEvents,
} from "@/db/schema";
import type { PluginEmbedder } from "@sentry/junior-plugin-api";
import { guardedCosineDistance } from "@sentry/junior-plugin-api/embeddings";
import { embedConversationQuery } from "./embedding";
import { lexemesSql, searchedEventTextSql, seqIn } from "./event-lexemes";
import {
  callsToolSql,
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
const BM25_B = 0.75;
// The agent's tool calls repeat the words of its own commands and searches,
// so in each leg a tool call counts half as much as other events. With RRF
// k = 60, a tool call at rank 1 then scores below an event at rank 61.
const TOOL_CALL_WEIGHT = 0.5;

/** Events that a search returns when the call sets no limit. */
export const DEFAULT_EVENT_SEARCH_LIMIT = 25;

/** One event search. The bounds and types only make the result smaller. */
export interface ConversationEventTextSearch {
  afterSeq?: number;
  beforeSeq?: number;
  conversationId: string;
  /**
   * The running Turn of this Conversation. Its input is in the model
   * context already, so it is not a result.
   */
  currentTurnId?: string;
  /** Embeds the query to also match events by meaning. */
  embedder?: PluginEmbedder;
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
      const idf = bm25InverseDocumentFrequency(
        total,
        documentFrequency.get(term) ?? 0,
      );
      const frequency = bm25NormalizedFrequency(
        tf,
        candidate.length,
        meanLength,
        BM25_B,
      );
      return sum + idf * bm25Saturation(frequency);
    }, 0);
  return candidates
    .map((candidate) => ({ seq: candidate.seq, score: score(candidate) }))
    .sort((left, right) => right.score - left.score || right.seq - left.seq)
    .map(({ seq }) => seq);
}

/**
 * Fuse ranked event lists with reciprocal rank fusion. An event in both
 * lists ranks above an event in one. Events in `toolCalls` count
 * `TOOL_CALL_WEIGHT` as much. Ties go to the newer event.
 */
export function fuseEventRanks(
  lists: readonly (readonly number[])[],
  toolCalls: ReadonlySet<number> = new Set(),
): number[] {
  // Each leg splits into its tool calls and the rest. Both keep the rank in
  // the leg, and the tool calls get the lower weight.
  const ranked = lists.flatMap((list) => {
    const entries = list.map((seq, index) => ({ item: seq, rank: index + 1 }));
    return [
      entries.filter((entry) => !toolCalls.has(entry.item)),
      entries.filter((entry) => toolCalls.has(entry.item)),
    ];
  });
  return fuseRankedLists(ranked, {
    key: (seq) => seq,
    tiebreak: (left, right) => right - left,
    weights: ranked.map((_, index) => (index % 2 ? TOOL_CALL_WEIGHT : 1)),
  });
}

async function searchBounds(
  db: JuniorDatabase,
  search: ConversationEventTextSearch,
  types: readonly string[],
): Promise<{ bounds: SQL | undefined; turnStartedSeq?: number }> {
  const events = juniorConversationEvents;
  const turn =
    search.currentTurnId === undefined
      ? undefined
      : await notTurnInput(db, search.conversationId, search.currentTurnId);
  return {
    bounds: and(
      eq(events.conversationId, search.conversationId),
      inArray(events.type, [...types]),
      search.afterSeq === undefined
        ? undefined
        : gt(events.seq, search.afterSeq),
      search.beforeSeq === undefined
        ? undefined
        : lt(events.seq, search.beforeSeq),
      turn?.filter,
    ),
    ...(turn ? { turnStartedSeq: turn.startedSeq } : undefined),
  };
}

// The input of a Turn: its input Messages, and the agent history messages
// that the Turn adds for its input and for steering, after it starts.
async function notTurnInput(
  db: JuniorDatabase,
  conversationId: string,
  turnId: string,
): Promise<{ filter: SQL; startedSeq: number } | undefined> {
  const events = juniorConversationEvents;
  const [started] = await db
    .select({
      seq: events.seq,
      inputMessageIds: sql<string[]>`${events.payload}->'inputMessageIds'`,
    })
    .from(events)
    .where(
      and(
        eq(events.conversationId, conversationId),
        eq(events.type, "turn_started"),
        eq(sql`${events.payload}->>'turnId'`, turnId),
      ),
    )
    .limit(1);
  if (!started) return undefined;
  return {
    filter: not(
      or(
        and(eq(events.type, "user_message"), gt(events.seq, started.seq)),
        and(
          inArray(events.type, ["message", "message_updated"]),
          inArray(
            sql`${events.payload}->>'messageId'`,
            started.inputMessageIds,
          ),
        ),
      )!,
    ),
    startedSeq: started.seq,
  };
}

const RESULT_KINDS = [
  "assistant_message",
  "message",
  "tool_call",
  "tool_result",
  "user_message",
] as const;

function resultKind(
  type: string,
  callsTool: boolean,
): (typeof RESULT_KINDS)[number] {
  if (callsTool) return "tool_call";
  switch (type) {
    case "assistant_message":
    case "tool_result":
    case "user_message":
      return type;
    default:
      return "message";
  }
}

// Counts of returned events by kind and from the running Turn, to see what
// fills the results. No content.
function resultMixAttributes(
  prefix: "result" | "top5",
  results: readonly { seq: number; type: string }[],
  toolCalls: ReadonlySet<number>,
  turnStartedSeq: number | undefined,
): Record<string, number> {
  const counts = Object.fromEntries(
    RESULT_KINDS.map((kind) => [`app.event_search.${prefix}.${kind}.count`, 0]),
  );
  for (const result of results) {
    counts[
      `app.event_search.${prefix}.${resultKind(result.type, toolCalls.has(result.seq))}.count`
    ]! += 1;
  }
  if (turnStartedSeq !== undefined) {
    counts[`app.event_search.${prefix}.current_turn.count`] = results.filter(
      (result) => result.seq > turnStartedSeq,
    ).length;
  }
  return counts;
}

async function toolCallSeqs(
  db: JuniorDatabase,
  conversationId: string,
  seqs: readonly number[],
): Promise<Set<number>> {
  if (seqs.length === 0) return new Set();
  const events = juniorConversationEvents;
  const rows = await db
    .select({ seq: events.seq })
    .from(events)
    .where(
      and(
        eq(events.conversationId, conversationId),
        inArray(events.seq, [...seqs]),
        callsToolSql(),
      ),
    );
  return new Set(rows.map((row) => row.seq));
}

async function keywordRanks(
  db: JuniorDatabase,
  search: ConversationEventTextSearch,
  bounds: SQL | undefined,
): Promise<{ candidates: number; computed: number; seqs: number[] }> {
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
  const candidates = [...storedCandidates, ...computedCandidates];
  return {
    candidates: candidates.length,
    computed: unstored.length,
    seqs: rankKeywordCandidates(candidates, searched?.total ?? 0).slice(
      0,
      CANDIDATES_PER_LEG,
    ),
  };
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
): Promise<{ seqs: number[]; topDistance?: number }> {
  if (!search.embedder) return { seqs: [] };
  const query = await embedConversationQuery(search.embedder, search.query);
  const events = juniorConversationEvents;
  const embeddings = juniorConversationEventEmbeddings;
  const distance = guardedCosineDistance({
    column: embeddings.embedding,
    dimensions: embeddings.dimensions,
    query: query.vector,
    type: "halfvec",
  });
  const rows = await db
    .select({ seq: embeddings.seq, distance })
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
    .orderBy(distance)
    .limit(CANDIDATES_PER_LEG);
  const top = rows[0];
  return {
    seqs: rows.map((row) => row.seq),
    ...(top ? { topDistance: Number(top.distance) } : undefined),
  };
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
  const { bounds, turnStartedSeq } = await searchBounds(db, search, types);
  const timed = async <T>(work: Promise<T>) => {
    const startedAt = Date.now();
    const result = await work;
    return { ...result, ms: Date.now() - startedAt };
  };
  const [keyword, meaning] = await Promise.all([
    timed(keywordRanks(db, search, bounds)),
    timed(meaningRanks(db, search, bounds)),
  ]);
  const toolCalls = await toolCallSeqs(db, search.conversationId, [
    ...new Set([...keyword.seqs, ...meaning.seqs]),
  ]);
  const seqs = fuseEventRanks([keyword.seqs, meaning.seqs], toolCalls).slice(
    0,
    search.limit,
  );
  setSpanAttributes({
    "app.event_search.keyword.candidate.count": keyword.candidates,
    "app.event_search.keyword.computed.count": keyword.computed,
    "app.event_search.keyword_ms": keyword.ms,
    "app.event_search.result.count": seqs.length,
    ...(search.embedder
      ? {
          "app.event_search.meaning.candidate.count": meaning.seqs.length,
          "app.event_search.meaning.top_distance": meaning.topDistance,
          "app.event_search.meaning_ms": meaning.ms,
        }
      : undefined),
  });
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
  const results = seqs.flatMap((seq) => {
    const row = bySeq.get(seq)?.row;
    return row ? [row] : [];
  });
  setSpanAttributes({
    ...resultMixAttributes("result", results, toolCalls, turnStartedSeq),
    ...resultMixAttributes(
      "top5",
      results.slice(0, 5),
      toolCalls,
      turnStartedSeq,
    ),
  });
  const terms = excerptTerms(search.query);
  return results.map((row) => ({
    event: eventFromRow(row),
    excerpt: eventExcerpt(bySeq.get(row.seq)?.text ?? "", terms),
  }));
}
