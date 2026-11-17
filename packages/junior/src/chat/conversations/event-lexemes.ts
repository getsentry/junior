/**
 * Stored full-text lexemes of searchable events, so keyword search reads
 * them instead of parsing every event on each query. The event search task
 * stores them after each completed Turn, newest events first. Keyword search
 * computes the lexemes of an event with no stored row, so old history and
 * apps without the task stay searchable.
 */
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationEventLexemes,
  juniorConversationEvents,
} from "@/db/schema";
import {
  eventSearchTextSql,
  SEARCHABLE_EVENT_TYPES,
} from "./event-search-text";

// Characters of one event that keyword search and excerpts read. The
// tsvector of this much text stays far below the 1 MB Postgres limit.
export const MAX_SEARCHED_EVENT_CHARS = 200_000;
// A run takes about 4 s on a local Postgres 17 for events of 5 KB each. A
// long Conversation catches up over later Turns.
const MAX_EVENTS_PER_RUN = 2_000;
// The Postgres parser keeps a path, a URL, or a repository reference as one
// lexeme. Spaces in their place let a query match each part, such as a file
// name or a pull request number.
const LEXEME_SEPARATORS = "/#\\:@?&=";
const LEXEME_SEPARATOR_SPACES = " ".repeat(LEXEME_SEPARATORS.length);

/** Lexemes of query or event text, split the same way for both. */
export function lexemesSql(text: SQL | string): SQL {
  return sql`to_tsvector('english', translate(${text}, ${LEXEME_SEPARATORS}, ${LEXEME_SEPARATOR_SPACES}))`;
}

/** Match event seqs against one array parameter, however many there are. */
export function seqIn(seqs: readonly number[]): SQL {
  return sql`${juniorConversationEvents.seq} = ANY(${`{${seqs.join(",")}}`}::integer[])`;
}

/** Searchable text of the current event row, as far as search reads it. */
export function searchedEventTextSql(): SQL<string | null> {
  return sql<
    string | null
  >`left(${eventSearchTextSql()}, ${MAX_SEARCHED_EVENT_CHARS})`;
}

/**
 * Store the lexemes of the newest searchable events of one Conversation that
 * have none. Return how many it stored. Retries are safe: a stored row is
 * kept.
 */
export async function storeConversationEventLexemes(
  db: JuniorDatabase,
  conversationId: string,
): Promise<number> {
  const events = juniorConversationEvents;
  const stored = juniorConversationEventLexemes;
  // The seqs come first, so Postgres parses only the events it stores. A
  // subquery in their place lets a stale row estimate pick a nested loop
  // that reruns it for each event.
  const unstored = await db
    .select({ seq: events.seq })
    .from(events)
    .leftJoin(
      stored,
      and(
        eq(stored.conversationId, events.conversationId),
        eq(stored.seq, events.seq),
      ),
    )
    .where(
      and(
        eq(events.conversationId, conversationId),
        inArray(events.type, [...SEARCHABLE_EVENT_TYPES]),
        isNull(stored.seq),
      ),
    )
    .orderBy(desc(events.seq))
    .limit(MAX_EVENTS_PER_RUN);
  if (unstored.length === 0) return 0;
  const rows = await db
    .insert(stored)
    .select(
      db
        .select({
          conversationId: events.conversationId,
          seq: events.seq,
          lexemes: sql`${lexemesSql(searchedEventTextSql())}`.as("lexemes"),
          createdAt: sql`now()`.as("created_at"),
        })
        .from(events)
        .where(
          and(
            eq(events.conversationId, conversationId),
            seqIn(unstored.map((row) => row.seq)),
          ),
        ),
    )
    .onConflictDoNothing()
    .returning({ seq: stored.seq });
  return rows.length;
}
