/**
 * Cost model for prompt cache warming.
 *
 * Ported from Lore's cache warmer (BYK/loreai,
 * `packages/gateway/src/cache-warmer.ts`). The model estimates the chance that
 * a person returns to an idle conversation before the cache expires. It then
 * compares that chance with the cost of one more warmup.
 */

/** Upper edges (ms) of the gap histogram bins. The last bin has no edge. */
const GAP_BIN_EDGES_MS: readonly number[] = [
  10_000, 20_000, 30_000, 45_000, 60_000, 90_000, 120_000, 180_000, 240_000,
  300_000, 420_000, 600_000, 900_000, 1_200_000, 1_800_000, 2_700_000,
  3_600_000, 5_400_000, 7_200_000, 14_400_000,
];
const GAP_BIN_COUNT = GAP_BIN_EDGES_MS.length + 1;

/** Gaps a conversation needs before its own gaps replace the global gaps. */
const BLEND_PSEUDOCOUNT = 20;

/** Below this prefix size, one cache miss costs too little to warm for. */
export const MIN_WARMUP_PREFIX_TOKENS = 50_000;

/** Anthropic's short cache TTL. Junior uses the default short retention. */
export const SHORT_CACHE_TTL_MS = 5 * 60_000;

const BASE_WARMUP_MARGIN_MS = 45_000;
const MARGIN_PER_PREFIX_TOKEN_MS = 0.27;
const MAX_SIZE_MARGIN_MS = 90_000;

interface GapHistogram {
  counts: number[];
  total: number;
}

function binIndex(gapMs: number): number {
  const index = GAP_BIN_EDGES_MS.findIndex((edge) => gapMs < edge);
  return index === -1 ? GAP_BIN_EDGES_MS.length : index;
}

function histogramOf(gapsMs: readonly number[]): GapHistogram {
  const counts = Array.from({ length: GAP_BIN_COUNT }, () => 0);
  for (const gap of gapsMs) {
    counts[binIndex(gap)]! += 1;
  }
  return { counts, total: gapsMs.length };
}

// A conversation with few gaps leans on the global gaps. Each conversation
// gap moves the weight by 1/BLEND_PSEUDOCOUNT.
function blendHistograms(
  conversation: GapHistogram,
  global: GapHistogram,
): GapHistogram {
  const weight = Math.min(conversation.total / BLEND_PSEUDOCOUNT, 1);
  return {
    counts: conversation.counts.map(
      (count, index) => weight * count + (1 - weight) * global.counts[index]!,
    ),
    total: weight * conversation.total + (1 - weight) * global.total,
  };
}

// S(t) = P(gap > t). The bin that holds t counts in proportion to the part of
// the bin that is after t.
function survival(histogram: GapHistogram, tMs: number): number {
  if (histogram.total === 0) return 1;
  const index = binIndex(tMs);
  let surviving = 0;
  for (let i = index + 1; i < GAP_BIN_COUNT; i++) {
    surviving += histogram.counts[i]!;
  }
  const binStart = index > 0 ? GAP_BIN_EDGES_MS[index - 1]! : 0;
  const binEnd = GAP_BIN_EDGES_MS[index];
  if (binEnd !== undefined) {
    const fractionPast = Math.min(
      1,
      Math.max(0, (tMs - binStart) / (binEnd - binStart)),
    );
    surviving += histogram.counts[index]! * (1 - fractionPast);
  }
  return surviving / histogram.total;
}

// P(return in [idle, idle + window] | still idle at idle).
function returnProbability(
  histogram: GapHistogram,
  idleMs: number,
  windowMs: number,
): number {
  const now = survival(histogram, idleMs);
  if (now < 0.001) return 0;
  return Math.max(0, (now - survival(histogram, idleMs + windowMs)) / now);
}

/**
 * Return how long before cache expiry to send a warmup. A large prefix needs
 * more headroom, so the margin grows with the prefix up to a fixed cap.
 */
export function warmupMarginMs(prefixTokens: number): number {
  return (
    BASE_WARMUP_MARGIN_MS +
    Math.min(
      Math.max(0, prefixTokens) * MARGIN_PER_PREFIX_TOKEN_MS,
      MAX_SIZE_MARGIN_MS,
    )
  );
}

/** Inputs for one warmup decision. Prices use one unit, such as $/MTok. */
export interface WarmupDecisionInput {
  /** Human gaps (ms) seen in this conversation. */
  conversationGapsMs: readonly number[];
  /** Recent human gaps (ms) across all conversations. */
  globalGapsMs: readonly number[];
  /** Time since the cached request started. */
  idleMs: number;
  /** 1 for the first warmup of this idle period. */
  cycle: number;
  prefixTokens: number;
  cacheReadPrice: number;
  cacheWritePrice: number;
}

/** Result of one warmup decision. */
export interface WarmupDecision {
  warm: boolean;
  reason: "warm" | "prefix_too_small" | "cycle_limit" | "unlikely_return";
  returnProbability: number;
  threshold: number;
}

/**
 * Decide whether to send the next warmup.
 *
 * Each warmup costs one cache read of the prefix. A return to a warm cache
 * saves one write minus one read. After k warmups, the return chance must be
 * above k·read/(write − read) (Lore's rising threshold). After
 * (write − read)/read warmups, warming always costs more than it can save.
 */
export function decideWarmup(input: WarmupDecisionInput): WarmupDecision {
  const savedPerReturn = input.cacheWritePrice - input.cacheReadPrice;
  const threshold =
    savedPerReturn > 0
      ? Math.min((input.cycle * input.cacheReadPrice) / savedPerReturn, 1)
      : 1;
  const histogram = blendHistograms(
    histogramOf(input.conversationGapsMs),
    histogramOf(input.globalGapsMs),
  );
  const probability = returnProbability(
    histogram,
    input.idleMs,
    SHORT_CACHE_TTL_MS,
  );
  const decision = (reason: WarmupDecision["reason"]): WarmupDecision => ({
    warm: reason === "warm",
    reason,
    returnProbability: probability,
    threshold,
  });
  if (input.prefixTokens < MIN_WARMUP_PREFIX_TOKENS) {
    return decision("prefix_too_small");
  }
  if (threshold >= 1) {
    return decision("cycle_limit");
  }
  return decision(probability >= threshold ? "warm" : "unlikely_return");
}
