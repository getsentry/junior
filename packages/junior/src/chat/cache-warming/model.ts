/**
 * Cost model for prompt cache warming.
 *
 * Ported from Lore's cache warmer (BYK/loreai,
 * `packages/gateway/src/cache-warmer.ts`). The model estimates the chance that
 * a person returns to an idle conversation before the cache expires. It then
 * compares that chance with the cost of one more warmup.
 */

import { isProviderRetryError } from "@/chat/services/provider-error";

/** One minute in milliseconds. */
export const MINUTE_MS = 60_000;

/** Upper edges (ms) of the gap histogram bins. */
const GAP_BIN_EDGES_MS: readonly number[] = [
  10_000,
  20_000,
  30_000,
  45_000,
  MINUTE_MS,
  1.5 * MINUTE_MS,
  2 * MINUTE_MS,
  3 * MINUTE_MS,
  4 * MINUTE_MS,
  5 * MINUTE_MS,
  7 * MINUTE_MS,
  10 * MINUTE_MS,
  15 * MINUTE_MS,
  20 * MINUTE_MS,
  30 * MINUTE_MS,
  45 * MINUTE_MS,
  60 * MINUTE_MS,
  90 * MINUTE_MS,
  120 * MINUTE_MS,
  240 * MINUTE_MS,
  Infinity,
];
const GAP_BIN_COUNT = GAP_BIN_EDGES_MS.length;

/**
 * Gaps that a list needs before it replaces the list it leans on: the
 * Conversation's gaps replace its segment's gaps, and a segment's gaps
 * replace its parent segment's gaps (`parentGapSegment`). A new or rare
 * segment starts with its parent's return chances, so it can warm before it
 * has gaps of its own.
 */
const BLEND_PSEUDOCOUNT = 20;

/**
 * Gaps that a decision needs in total, from the Conversation, its segment,
 * and a thin segment's parent. With fewer, one gap sets the return chance for
 * each Conversation of the segment, such as at launch or after the gap lists
 * expire.
 */
export const MIN_GAP_SAMPLES = 20;

/** Below this prefix size, one cache miss costs too little to warm for. */
export const MIN_WARMUP_PREFIX_TOKENS = 50_000;

/**
 * Junior watches an idle period for this long. A person who replies later
 * counts as a person who did not reply. The reply chance of a warmup counts
 * only replies before this time. For a cache that outlives the horizon, this
 * is less than the real chance, so Junior warms less, never more.
 *
 * The horizon message is signed when the idle period starts, and a queue
 * signature is valid for 60 minutes (`QUEUE_SIGNATURE_MAX_AGE_MS`). The other
 * 5 minutes let a late horizon still record its no-reply gap.
 */
export const IDLE_HORIZON_MS = 55 * MINUTE_MS;

/**
 * Whether a failed warmup request counts as a miss for the provider breaker.
 * A request that the provider rejects fails the same way for each
 * Conversation, so it counts. A retryable failure, such as an overload or a
 * timeout, says nothing about the cache, so it must not stop warming for
 * every Conversation.
 */
export function warmupFailureCountsAsMiss(error: unknown): boolean {
  return !isProviderRetryError(error);
}

/** Gap that Junior records for an idle period with no reply in the horizon. */
export const NO_REPLY_GAP_MS = 24 * 60 * MINUTE_MS;

interface GapHistogram {
  counts: number[];
  total: number;
}

function binIndex(gapMs: number): number {
  return GAP_BIN_EDGES_MS.findIndex((edge) => gapMs < edge);
}

function histogramOf(gapsMs: readonly number[]): GapHistogram {
  const counts = Array.from({ length: GAP_BIN_COUNT }, () => 0);
  for (const gap of gapsMs) {
    counts[binIndex(gap)]! += 1;
  }
  return { counts, total: gapsMs.length };
}

// A list with few gaps leans on a larger prior list: a Conversation on its
// segment, or a thin segment on its parent. Each own gap moves the weight by
// 1/BLEND_PSEUDOCOUNT. The two histograms are mixed as shares, so a much
// larger prior list does not hide the own gaps.
function blendHistograms(own: GapHistogram, prior: GapHistogram): GapHistogram {
  if (own.total === 0 || prior.total === 0) {
    return own.total === 0 ? prior : own;
  }
  const weight = Math.min(own.total / BLEND_PSEUDOCOUNT, 1);
  return {
    counts: own.counts.map(
      (count, index) =>
        (weight * count) / own.total +
        ((1 - weight) * prior.counts[index]!) / prior.total,
    ),
    total: 1,
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
  // The last bin has no end, so all of its gaps are after t.
  const fractionPast = Math.min(
    1,
    Math.max(0, (tMs - binStart) / (GAP_BIN_EDGES_MS[index]! - binStart)),
  );
  surviving += histogram.counts[index]! * (1 - fractionPast);
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
 * How long before cache expiry Junior sends a warmup. A warmup reads each
 * cache block of the prefix in one request, so the provider refreshes all
 * blocks together. A margin that grows with the prefix size gains nothing.
 * The margin covers only the queue delay and the time of the warmup request.
 */
export const WARMUP_MARGIN_MS = 45_000;

/**
 * Plugin work of a Conversation when its idle period starts. `open`: a plugin
 * reports unfinished work, so an event, such as a CI result, can still come.
 * `done`: all reported work finished and no person wrote after it finished.
 * `none`: no reported work, a person wrote after it finished, or a plugin
 * hook failed.
 */
export type WorkState = "open" | "done" | "none";

/** What Junior knows about a Conversation when its idle period starts. */
export interface GapSegmentInput {
  /** A person started the Turn that ended. */
  userActor: boolean;
  /** Turns of the Conversation that ended before this one. */
  endedTurns: number;
  workState: WorkState;
  archived: boolean;
}

/**
 * Pick the gap histogram for an idle period. Return chances differ most by
 * who started the Turn and by how many Turns the Conversation had before it.
 * Turns that no person started rarely get a quick reply. In 30 days of
 * production data, segments by these two keys saved more than one histogram.
 * Local time of day did not improve the result, so it is not a key.
 *
 * The work state lets the histograms learn how often anything returns after
 * the work is done. An event does not restore an archived Conversation, so
 * most returns to one are events, not people. Its segment has only the work
 * state, which keeps the number of segments small.
 */
export function gapSegment(input: GapSegmentInput): string {
  if (input.archived) return `archived:${input.workState}`;
  const depth = turnDepth(input.endedTurns);
  return `${input.userActor ? "user" : "system"}:${depth}:${input.workState}`;
}

/** Turn depth groups of `gapSegment`, in display order. */
export const TURN_DEPTHS = ["1", "2-3", "4+"] as const;

/**
 * Group the number of Turns that ended before an idle period. The first
 * Turns of a Conversation get replies at other rates than later ones.
 */
export function turnDepth(endedTurns: number): (typeof TURN_DEPTHS)[number] {
  return endedTurns === 0 ? "1" : endedTurns < 3 ? "2-3" : "4+";
}

/** Each segment that `gapSegment` returns, in display order. */
export const GAP_SEGMENTS: readonly string[] = [
  ...[true, false].flatMap((userActor) =>
    [0, 1, 3].flatMap((endedTurns) =>
      (["open", "done", "none"] as const).map((workState) =>
        gapSegment({ userActor, endedTurns, workState, archived: false }),
      ),
    ),
  ),
  ...(["open", "done", "none"] as const).map((workState) =>
    gapSegment({ userActor: false, endedTurns: 0, workState, archived: true }),
  ),
];

/**
 * Count gaps in the bins that `decideWarmup` uses, for reports. A gap at or
 * after `IDLE_HORIZON_MS` is a no-reply gap, as the recorder stores it. The
 * bins after the horizon never get a gap, so they are left out.
 */
export function gapHistogramReport(gapsMs: readonly number[]): {
  /** Gaps from `startMs` to before `endMs`. */
  bins: Array<{ startMs: number; endMs: number; count: number }>;
  noReply: number;
  total: number;
} {
  const { counts } = histogramOf(
    gapsMs.filter((gapMs) => gapMs < IDLE_HORIZON_MS),
  );
  const bins: Array<{ startMs: number; endMs: number; count: number }> = [];
  for (const [index, endMs] of GAP_BIN_EDGES_MS.entries()) {
    const startMs = index > 0 ? GAP_BIN_EDGES_MS[index - 1]! : 0;
    if (startMs >= IDLE_HORIZON_MS) break;
    bins.push({
      startMs,
      endMs: Math.min(endMs, IDLE_HORIZON_MS),
      count: counts[index]!,
    });
  }
  return {
    bins,
    noReply: gapsMs.filter((gapMs) => gapMs >= IDLE_HORIZON_MS).length,
    total: gapsMs.length,
  };
}

/**
 * Segment whose gaps a thin segment leans on: the `none` segment with the
 * same Actor and Turn depth. The backfill and most traffic keep the `none`
 * segments full. A `none` segment that is not archived has no parent.
 */
export function parentGapSegment(input: GapSegmentInput): string | undefined {
  if (!input.archived && input.workState === "none") return undefined;
  return gapSegment({ ...input, workState: "none", archived: false });
}

/** Whether a segment has too few gaps to stand without its parent. */
export function segmentNeedsParent(segmentGaps: number): boolean {
  return segmentGaps < BLEND_PSEUDOCOUNT;
}

/** Inputs for one warmup decision. Prices use one unit, such as $/MTok. */
export interface WarmupDecisionInput {
  /**
   * Reply gaps (ms) of the idle periods of this conversation. An idle period
   * with no reply counts as `NO_REPLY_GAP_MS`.
   */
  conversationGapsMs: readonly number[];
  /**
   * Recent reply gaps (ms) of the same `gapSegment` across all
   * conversations, recorded the same way.
   */
  globalGapsMs: readonly number[];
  /**
   * Gaps of the `parentGapSegment`. They count only while the segment is
   * thin (`segmentNeedsParent`).
   */
  parentGapsMs?: readonly number[];
  /** Time since the cached request started. */
  idleMs: number;
  /**
   * Idle time at which the current cache expires. Returns before it read the
   * cache without a warmup, so no plan gets credit for them.
   */
  cacheExpiryIdleMs: number;
  /** How long the cache lives after a read (`cacheTtlMs` in `warmup.ts`). */
  cacheTtlMs: number;
  prefixTokens: number;
  cacheReadPrice: number;
  cacheWritePrice: number;
}

/** Result of one warmup decision. */
export interface WarmupDecision {
  warm: boolean;
  reason:
    | "warm"
    | "prefix_too_small"
    | "no_savings"
    | "horizon"
    | "few_gaps"
    | "unlikely_return";
  /** Chance of a return in the next TTL. */
  returnProbability: number;
  /** Best returns per warmup over the plans that `decideWarmup` compares. */
  returnsPerWarmup: number;
  threshold: number;
  /** The parent segment's gaps filled in for a thin segment. */
  parentPrior: boolean;
}

/**
 * Decide whether to send the next warmup.
 *
 * A warmup costs one cache read of the prefix. A return to a warm cache saves
 * one write minus one read. So warming pays when the expected returns per
 * warmup are above read/(write − read). Earlier warmups are already paid, so
 * the threshold is the same for each warmup.
 *
 * One warmup alone can be useless when people return a little after the next
 * TTL, while two or three warmups in a row would reach them. So the decision
 * compares plans of 1, 2, ... warmups up to the horizon. Each plan sends its
 * next warmup only while nobody returned. Junior warms when the best plan
 * pays, and decides again at the next warmup.
 */
export function decideWarmup(input: WarmupDecisionInput): WarmupDecision {
  const savedPerReturn = input.cacheWritePrice - input.cacheReadPrice;
  const threshold =
    savedPerReturn > 0 ? Math.min(input.cacheReadPrice / savedPerReturn, 1) : 1;
  const conversation = histogramOf(input.conversationGapsMs);
  const global = histogramOf(input.globalGapsMs);
  const parent =
    input.parentGapsMs && segmentNeedsParent(global.total)
      ? histogramOf(input.parentGapsMs)
      : undefined;
  const histogram = blendHistograms(
    conversation,
    parent ? blendHistograms(global, parent) : global,
  );
  const probability = returnProbability(
    histogram,
    input.idleMs,
    Math.min(input.cacheTtlMs, IDLE_HORIZON_MS - input.idleMs),
  );
  const perWarmup = returnsPerWarmup(
    histogram,
    input.idleMs,
    input.cacheExpiryIdleMs,
    input.cacheTtlMs,
  );
  const decision = (reason: WarmupDecision["reason"]): WarmupDecision => ({
    warm: reason === "warm",
    reason,
    returnProbability: probability,
    returnsPerWarmup: perWarmup,
    threshold,
    parentPrior: (parent?.total ?? 0) > 0,
  });
  if (input.prefixTokens < MIN_WARMUP_PREFIX_TOKENS) {
    return decision("prefix_too_small");
  }
  if (threshold >= 1) {
    return decision("no_savings");
  }
  if (input.idleMs >= IDLE_HORIZON_MS) {
    return decision("horizon");
  }
  if (
    conversation.total + global.total + (parent?.total ?? 0) <
    MIN_GAP_SAMPLES
  ) {
    return decision("few_gaps");
  }
  return decision(perWarmup >= threshold ? "warm" : "unlikely_return");
}

// Best expected returns per warmup over plans of 1, 2, ... warmups that end
// at the horizon. Each warmup runs one margin before the cache from the
// previous warmup expires, so warmups come every TTL minus the margin. A
// warmup runs only if nobody returned before it. A plan gets credit only for
// returns after the current cache expires.
function returnsPerWarmup(
  histogram: GapHistogram,
  idleMs: number,
  cacheExpiryIdleMs: number,
  ttlMs: number,
): number {
  const now = survival(histogram, idleMs);
  const intervalMs = ttlMs - WARMUP_MARGIN_MS;
  if (now < 0.001 || intervalMs <= 0) return 0;
  const leftAtExpiry = survival(
    histogram,
    Math.min(cacheExpiryIdleMs, IDLE_HORIZON_MS),
  );
  let best = 0;
  let warmups = 0;
  for (let startMs = idleMs; startMs < IDLE_HORIZON_MS; startMs += intervalMs) {
    warmups += survival(histogram, startMs) / now;
    const endMs = Math.min(startMs + ttlMs, IDLE_HORIZON_MS);
    const returns =
      Math.max(0, leftAtExpiry - survival(histogram, endMs)) / now;
    best = Math.max(best, returns / warmups);
  }
  return best;
}
