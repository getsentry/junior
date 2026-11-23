import { fuseRankedLists, type RankedEntry } from "./rank-fusion";

/** One way that a search finds matches. Each way ranks its own matches. */
export type SearchLeg = "exact" | "fuzzy" | "lexical" | "vector";

const SEARCH_LEGS: readonly SearchLeg[] = [
  "exact",
  "lexical",
  "fuzzy",
  "vector",
];

/** A match, with its rank in each way that found it. Rank 1 is the best. */
export interface SearchMatch<T> {
  item: T;
  ranks: Partial<Record<SearchLeg, number>>;
}

/**
 * Rank values that are already in order, best first. Equal keys share a
 * rank, and the next key takes its position: 1, 1, 3.
 */
export function withDenseRanks<T>(
  values: T[],
  key: (value: T) => string | number,
): Array<{ rank: number; value: T }> {
  let previous: string | number | undefined;
  let rank = 0;
  return values.map((value, index) => {
    const current = key(value);
    if (index === 0 || current !== previous) {
      rank = index + 1;
      previous = current;
    }
    return { rank, value };
  });
}

/**
 * Rank each way's matches by its score, larger is better. A row is in a
 * way only when its score is defined.
 */
export function scoredSearchMatches<T>(
  rows: readonly T[],
  scores: Partial<Record<SearchLeg, (row: T) => number | undefined>>,
): SearchMatch<T>[] {
  const matches: SearchMatch<T>[] = rows.map((item) => ({ item, ranks: {} }));
  for (const leg of SEARCH_LEGS) {
    const score = scores[leg];
    if (!score) continue;
    const scored = matches.flatMap((match) => {
      const value = score(match.item);
      return value === undefined ? [] : [{ match, value }];
    });
    scored.sort((left, right) => right.value - left.value);
    for (const { rank, value: entry } of withDenseRanks(
      scored,
      (row) => row.value,
    )) {
      entry.match.ranks[leg] = rank;
    }
  }
  return matches;
}

/**
 * Fuse the ranks of every way that found each match into one order, best
 * first, with reciprocal rank fusion. Raw scores of two ways are never
 * compared, so any source can add a way. `weights` default to 1.
 */
export function rankSearchMatches<T>(
  matches: readonly SearchMatch<T>[],
  options: {
    key: (item: T) => string | number;
    tiebreak?: (left: T, right: T) => number;
    weights?: Partial<Record<SearchLeg, number>>;
  },
): T[] {
  const lists = SEARCH_LEGS.map((leg) =>
    matches.flatMap((match): RankedEntry<T>[] => {
      const rank = match.ranks[leg];
      return rank === undefined ? [] : [{ item: match.item, rank }];
    }),
  );
  return fuseRankedLists(lists, {
    key: options.key,
    weights: SEARCH_LEGS.map((leg) => options.weights?.[leg] ?? 1),
    ...(options.tiebreak ? { tiebreak: options.tiebreak } : undefined),
  });
}
