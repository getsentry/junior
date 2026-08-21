import type { MemoryRecord } from "./store";

const RECIPROCAL_RANK_FUSION_K = 60;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RRF_WEIGHT = 1;

export interface MemoryMatch {
  lexical?: {
    rank: number;
  };
  memory: MemoryRecord;
  sourceKey: string;
  vector?: {
    rank: number;
  };
}

function reciprocalRank(rank: number, weight: number): number {
  return weight / (RECIPROCAL_RANK_FUSION_K + rank);
}

function matchScore(
  match: MemoryMatch,
  weights: { lexicalWeight: number; vectorWeight: number },
): number {
  return (
    (match.vector
      ? reciprocalRank(match.vector.rank, weights.vectorWeight)
      : 0) +
    (match.lexical
      ? reciprocalRank(match.lexical.rank, weights.lexicalWeight)
      : 0)
  );
}

function currentChannel(
  match: Pick<MemoryMatch, "sourceKey">,
  channelPrefix: string | undefined,
): boolean {
  return channelPrefix ? match.sourceKey.startsWith(channelPrefix) : false;
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
    channelPrefix?: string;
    /** Optional RRF weight for the lexical leg. Defaults to 1. */
    lexicalWeight?: number;
    nowMs: number;
    /** Optional RRF weight for the vector leg. Defaults to 1. */
    vectorWeight?: number;
  },
): MemoryMatch[] {
  const weights = {
    lexicalWeight: positiveWeight(options.lexicalWeight, DEFAULT_RRF_WEIGHT),
    vectorWeight: positiveWeight(options.vectorWeight, DEFAULT_RRF_WEIGHT),
  };
  const byId = new Map<string, MemoryMatch>();
  for (const match of matches) {
    const existing = byId.get(match.memory.id);
    if (!existing) {
      byId.set(match.memory.id, match);
      continue;
    }
    // Keep the first rank per modality. Shared legs are fused before private
    // probes, so a smaller private top-k cannot overwrite a shared dense rank
    // with an inflated top rank for the same memory.
    byId.set(match.memory.id, {
      ...existing,
      ...(!existing.lexical && match.lexical
        ? { lexical: match.lexical }
        : undefined),
      ...(!existing.vector && match.vector ? { vector: match.vector } : undefined),
    });
  }
  return [...byId.values()].sort((left, right) => {
    const scoreDelta = matchScore(right, weights) - matchScore(left, weights);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    // Prefer actor preferences over workspace knowledge when RRF ties. Shared
    // lexical legs often assign the same top rank to recent public noise and a
    // private-scope probe hit for the same common token.
    const privateDelta =
      Number(right.memory.scope === "private") -
      Number(left.memory.scope === "private");
    if (privateDelta !== 0) {
      return privateDelta;
    }
    const channelDelta =
      Number(currentChannel(right, options.channelPrefix)) -
      Number(currentChannel(left, options.channelPrefix));
    if (channelDelta !== 0) {
      return channelDelta;
    }
    return (
      observedAgeRank(right.memory, options.nowMs) -
        observedAgeRank(left.memory, options.nowMs) ||
      right.memory.observedAtMs - left.memory.observedAtMs ||
      left.memory.id.localeCompare(right.memory.id)
    );
  });
}
