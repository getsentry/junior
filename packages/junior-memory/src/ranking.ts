import type { MemoryRecord } from "./store";

const RECIPROCAL_RANK_FUSION_K = 60;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface MemoryMatch {
  exactIdentifier: boolean;
  lexical?: {
    rank: number;
  };
  memory: MemoryRecord;
  sourceKey: string;
  vector?: {
    rank: number;
  };
}

function reciprocalRank(rank: number): number {
  return 1 / (RECIPROCAL_RANK_FUSION_K + rank);
}

function matchScore(match: MemoryMatch): number {
  return (
    (match.vector ? reciprocalRank(match.vector.rank) : 0) +
    (match.lexical ? reciprocalRank(match.lexical.rank) : 0)
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

/**
 * Keep exact structured-identifier matches in the strongest relevance tier,
 * then fuse lexical and vector ranks without comparing provider raw scores.
 */
export function rankMemoryMatches(
  matches: MemoryMatch[],
  options: {
    channelPrefix?: string;
    nowMs: number;
  },
): MemoryMatch[] {
  const byId = new Map<string, MemoryMatch>();
  for (const match of matches) {
    const existing = byId.get(match.memory.id);
    if (!existing) {
      byId.set(match.memory.id, match);
      continue;
    }
    byId.set(match.memory.id, {
      ...existing,
      exactIdentifier: existing.exactIdentifier || match.exactIdentifier,
      ...(match.lexical ? { lexical: match.lexical } : {}),
      ...(match.vector ? { vector: match.vector } : {}),
    });
  }
  return [...byId.values()].sort((left, right) => {
    const identifierDelta =
      Number(right.exactIdentifier) - Number(left.exactIdentifier);
    if (identifierDelta !== 0) {
      return identifierDelta;
    }
    const scoreDelta = matchScore(right) - matchScore(left);
    if (scoreDelta !== 0) {
      return scoreDelta;
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
