import type { ConversationMetricDay } from "@sentry/junior/api/schema";

export const CACHE_INPUT_SERIES = [
  { key: "cachedInputTokens", label: "From cache", color: "#22d3ee" },
  { key: "cacheCreationTokens", label: "Written to cache", color: "#fbbf24" },
  { key: "inputTokens", label: "Uncached", color: "#a78bfa" },
] as const;

export type CacheInput = Pick<
  ConversationMetricDay,
  "cachedInputTokens" | "cacheCreationTokens" | "inputTokens"
>;

/** Add disjoint SQL input counters. Missing fields are not known zeroes. */
export function cacheInputTotal(input: CacheInput): number | undefined {
  if (CACHE_INPUT_SERIES.some(({ key }) => input[key] === undefined)) {
    return undefined;
  }
  return CACHE_INPUT_SERIES.reduce((sum, { key }) => sum + input[key]!, 0);
}

/** Format a share without rounding a nonzero miss rate up to 100%. */
export function formatCacheShare(
  value: number | undefined,
  total: number | undefined,
): string {
  if (value === undefined || total === undefined || total === 0) return "—";
  const percent = (value / total) * 100;
  if (percent < 100 && percent >= 99.95) return "<100%";
  if (percent > 0 && percent < 0.05) return "<0.1%";
  return `${percent.toFixed(1)}%`;
}

/** Distinguish unused periods from periods with missing input counters. */
export function hasCacheActivity(day: ConversationMetricDay): boolean {
  return (
    CACHE_INPUT_SERIES.some(({ key }) => day[key] !== undefined) ||
    (day.tokens ?? 0) > 0 ||
    day.durationMs > 0 ||
    day.conversations > 0
  );
}

/** Sum reported values but suppress shares when an active period lacks a field. */
export function summarizeCacheInput(days: ConversationMetricDay[]) {
  const active = days.filter(hasCacheActivity);
  const input: CacheInput = {};
  for (const { key } of CACHE_INPUT_SERIES) {
    if (active.length && active.every((day) => day[key] !== undefined)) {
      input[key] = active.reduce((sum, day) => sum + day[key]!, 0);
    }
  }
  return {
    input,
    total: cacheInputTotal(input),
    activePeriods: active.length,
    incompletePeriods: active.filter(
      (day) => cacheInputTotal(day) === undefined,
    ).length,
  };
}
