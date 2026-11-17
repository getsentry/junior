/** One entry of a ranked list. Rank 1 is the best. */
export interface RankedEntry<T> {
  item: T;
  rank: number;
}

const DEFAULT_RANK_FUSION_K = 60;

/**
 * Fuse ranked lists with reciprocal rank fusion. Each list adds
 * `weight / (k + rank)` to the score of an item, so an item in more lists
 * ranks higher, and the raw scores of two lists are never compared. Entries
 * with the same key are one item: the first entry of a key in a list counts,
 * and the first entry of a key overall is the item returned. Returns items
 * best first. `tiebreak` orders items with equal scores.
 */
export function fuseRankedLists<T>(
  lists: readonly (readonly RankedEntry<T>[])[],
  options: {
    key: (item: T) => string | number;
    /** Default 60. */
    k?: number;
    /** One weight per list, in list order. Default 1. */
    weights?: readonly number[];
    tiebreak?: (left: T, right: T) => number;
  },
): T[] {
  const k = options.k ?? DEFAULT_RANK_FUSION_K;
  const fused = new Map<string | number, { item: T; score: number }>();
  for (const [listIndex, list] of lists.entries()) {
    const weight = options.weights?.[listIndex] ?? 1;
    const seen = new Set<string | number>();
    for (const entry of list) {
      const key = options.key(entry.item);
      if (seen.has(key)) continue;
      seen.add(key);
      const current = fused.get(key) ?? { item: entry.item, score: 0 };
      current.score += weight / (k + entry.rank);
      fused.set(key, current);
    }
  }
  return [...fused.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        (options.tiebreak?.(left.item, right.item) ?? 0),
    )
    .map(({ item }) => item);
}
