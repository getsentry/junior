import { fuseRankedLists } from "@/search/rank-fusion";
import type { MemoryRecord } from "./store";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RRF_WEIGHT = 1;

export interface MemoryMatch {
  lexical?: {
    rank: number;
  };
  memory: MemoryRecord;
  vector?: {
    rank: number;
  };
}

function observedAgeRank(memory: MemoryRecord, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - memory.observedAtMs);
  if (ageMs <= 7 * ONE_DAY_MS) {
    return 3;
  }
  if (ageMs <= 30 * ONE_DAY_MS) {
    return 2;
  }
  if (ageMs <= 90 * ONE_DAY_MS) {
    return 1;
  }
  return 0;
}

function positiveWeight(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/** Fuse lexical and vector ranks without comparing provider raw scores. */
export function rankMemoryMatches(
  matches: MemoryMatch[],
  options: {
    /** Optional RRF weight for the lexical leg. Defaults to 1. */
    lexicalWeight?: number;
    nowMs: number;
    /** Optional RRF weight for the vector leg. Defaults to 1. */
    vectorWeight?: number;
  },
): MemoryMatch[] {
  const vector = matches.flatMap((match) =>
    match.vector ? [{ item: match, rank: match.vector.rank }] : [],
  );
  const lexical = matches.flatMap((match) =>
    match.lexical ? [{ item: match, rank: match.lexical.rank }] : [],
  );
  return fuseRankedLists([vector, lexical], {
    key: (match) => match.memory.id,
    weights: [
      positiveWeight(options.vectorWeight, DEFAULT_RRF_WEIGHT),
      positiveWeight(options.lexicalWeight, DEFAULT_RRF_WEIGHT),
    ],
    tiebreak: (left, right) =>
      observedAgeRank(right.memory, options.nowMs) -
        observedAgeRank(left.memory, options.nowMs) ||
      right.memory.observedAtMs - left.memory.observedAtMs ||
      left.memory.id.localeCompare(right.memory.id),
  });
}
