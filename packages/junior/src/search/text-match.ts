import { sql, type SQL } from "drizzle-orm";
import type { TypedQuery } from "./typed-query";

/**
 * The most matches that one source ranks for a query. An index finds the
 * matches, but no index can rank them, so a source keeps its newest
 * matches up to this count and ranks only those.
 */
export const SEARCH_RANK_WINDOW = 200;

/** SQL: the `simple` tsquery of typed text, each word as a prefix. */
export function prefixTsquery(query: TypedQuery): SQL {
  return sql`to_tsquery('simple', ${query.prefix})`;
}

/**
 * SQL: a `simple` search document has a word that each word of the query
 * starts. A GIN index on the document finds the rows.
 */
export function prefixMatch(document: SQL, query: TypedQuery): SQL<boolean> {
  return sql<boolean>`(${document} @@ ${prefixTsquery(query)})`;
}

/**
 * SQL: how well a document matches the query, larger is better. Words in
 * a heavier field and words close together rank higher. Rank only the rows
 * of a bounded window, because it reads each document.
 */
export function prefixRank(document: SQL, query: TypedQuery): SQL<number> {
  return sql<number>`ts_rank_cd(${document}, ${prefixTsquery(query)})`;
}

/**
 * SQL: some extent of the lowercase text has most of the query's trigrams,
 * so a title matches through a typo. A GIN `gin_trgm_ops` index on the text
 * finds the rows. False for a query too short to match by trigrams.
 */
export function fuzzyMatch(text: SQL, query: TypedQuery): SQL<boolean> {
  return query.fuzzy
    ? sql<boolean>`(${query.fuzzy} <% ${text})`
    : sql<boolean>`false`;
}

/** SQL: how close the lowercase text is to the query, from 0 to 1. */
export function fuzzyRank(text: SQL, query: TypedQuery): SQL<number> {
  return query.fuzzy
    ? sql<number>`word_similarity(${query.fuzzy}, ${text})`
    : sql<number>`0`;
}
