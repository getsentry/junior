/**
 * What cache warming saves, as daily `junior_stats` counters for the System
 * page.
 *
 * When the next model call ends an idle period, the period counts once,
 * whether or not warmups ran. A period with no warm state counts too, such as
 * one whose snapshot was too large, so the oracle shows the gaps that the
 * warmer never covered. A hit saves the cache write that the call would have
 * made without warming. The oracle is what an ideal warmer saves: it knows the
 * gap, so it sends only the warmups that the gap needs, and only when they cost
 * less than the write. Each warmup adds its own cost when it runs, so
 * warmups of periods with no return count too. A tool wait counts as an idle
 * period (`tool-wait.ts`).
 */
import { logWarn } from "@/chat/logging";
import { addStats, firstStatDate, replaceStats, type Stat } from "@/stats";
import { MIN_WARMUP_PREFIX_TOKENS, WARMUP_MARGIN_MS } from "./model";

/** `junior_stats` namespace of the cache warming counters. */
export const SAVINGS_NAMESPACE = "cache_warming";
/**
 * Dollar counters store this many units per dollar. A day of one model then
 * fits the integer counter up to about $200,000.
 */
const UNITS_PER_USD = 10_000;
const METRICS = {
  hits: "hits",
  idlePeriods: "idle_periods",
  oracleSavings: "oracle_savings",
  saved: "saved",
  unwarmedIdlePeriods: "unwarmed_idle_periods",
  unwarmedOracleSavings: "unwarmed_oracle_savings",
  warmupCost: "warmup_cost",
  historyDays: "history_days",
} as const;
// The provider starts its TTL clock a few seconds after the request starts.
// Reads still hit until about 310s after a request with a 300s TTL.
const TTL_START_DELAY_MS = 10_000;
// A call that read at least this share of the prefix hit the cache. A call
// whose cached tokens are below it had a smaller context, as after compaction,
// or no usage.
const PREFIX_SHARE = 0.5;

/** Dollar savings of one idle period that counts. */
export interface IdlePeriodSavings {
  hit: boolean;
  oracleUsd: number;
  savedUsd: number;
}

/**
 * Return the savings of an idle period that a call ends `gapMs` after the
 * request that started it. Return none for a period that does not count: the
 * prefix is too small to warm, the model has no cache prices that warming
 * pays for, the cache lived through the gap without warmups, the context
 * shrank, or warming could never pay for the gap. Prices are in dollars per
 * million tokens.
 */
export function idlePeriodSavings(input: {
  cacheTtlMs: number;
  gapMs: number;
  prefixTokens: number;
  /** Cache tokens of the call that ends the idle period. */
  cacheRead: number;
  cacheWrite: number;
  cacheReadPrice: number;
  cacheWritePrice: number;
}): IdlePeriodSavings | undefined {
  if (
    input.prefixTokens < MIN_WARMUP_PREFIX_TOKENS ||
    !(input.cacheReadPrice > 0) ||
    !(input.cacheWritePrice > input.cacheReadPrice)
  ) {
    return undefined;
  }
  const lateMs = input.gapMs - input.cacheTtlMs - TTL_START_DELAY_MS;
  if (lateMs <= 0) return undefined;
  const minTokens = PREFIX_SHARE * input.prefixTokens;
  if (input.cacheRead + input.cacheWrite < minTokens) return undefined;
  const warmups = Math.ceil(lateMs / (input.cacheTtlMs - WARMUP_MARGIN_MS));
  const read = input.cacheReadPrice / 1_000_000;
  const write = input.cacheWritePrice / 1_000_000;
  if (warmups * read >= write - read) return undefined;
  const writeSavedUsd = input.prefixTokens * (write - read);
  const hit = input.cacheRead >= minTokens;
  return {
    hit,
    oracleUsd: writeSavedUsd - warmups * input.prefixTokens * read,
    savedUsd: hit ? writeSavedUsd : 0,
  };
}

const units = (usd: number) => Math.round(usd * UNITS_PER_USD);

/** Counter amounts, by metric. */
export type SavingsCounts = Partial<Record<keyof typeof METRICS, number>>;

const savingsStats = (modelId: string, counts: SavingsCounts) =>
  Object.entries(counts).map(([metric, count]) => ({
    namespace: SAVINGS_NAMESPACE,
    metric: METRICS[metric as keyof typeof METRICS],
    name: modelId,
    count,
  }));

// Counter amounts of one idle period. `warmed` is unset for a period whose
// warm state is not known.
function periodCounts(
  savings: IdlePeriodSavings,
  warmed?: boolean,
): SavingsCounts {
  const oracle = units(savings.oracleUsd);
  return {
    idlePeriods: 1,
    hits: savings.hit ? 1 : 0,
    oracleSavings: oracle,
    saved: units(savings.savedUsd),
    ...(warmed === false
      ? { unwarmedIdlePeriods: 1, unwarmedOracleSavings: oracle }
      : undefined),
  };
}

// The counters only report savings. A failure to write them is logged and
// does not change warming.
async function addSavingsStats(
  modelId: string,
  counts: SavingsCounts,
): Promise<void> {
  if (!process.env["DATABASE_URL"]) return;
  try {
    await addStats(savingsStats(modelId, counts));
  } catch (error) {
    logWarn("cache_warming.savings.record_failed", {
      "gen_ai.request.model": modelId,
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Count one idle period that counts, as `idlePeriodSavings` returned it.
 * `warmed` is false for a period with no warm state.
 */
export async function recordIdlePeriodSavings(
  modelId: string,
  savings: IdlePeriodSavings,
  warmed: boolean,
): Promise<void> {
  await addSavingsStats(modelId, periodCounts(savings, warmed));
}

/** Add the cost of one warmup call. */
export async function recordWarmupCost(
  modelId: string,
  costUsd: number,
): Promise<void> {
  await addSavingsStats(modelId, { warmupCost: units(costUsd) });
}

/**
 * Counter sums of idle periods from stored history, per UTC day and model.
 * Plain JSON, so a job can keep them in state between slices.
 */
export type HistorySavings = Record<string, Record<string, SavingsCounts>>;

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Add one idle period from stored history that `idlePeriodSavings` counted,
 * on the day of `endedAtMs`, the start of the call that ended it.
 *
 * History does not say whether a period had warm state, so it does not count
 * as unwarmed. History has no warmup calls, so it adds no warmup cost.
 */
export function addHistoryPeriod(
  sums: HistorySavings,
  endedAtMs: number,
  modelId: string,
  savings: IdlePeriodSavings,
): void {
  const byModel = (sums[utcDate(endedAtMs)] ??= {});
  const counts = (byModel[modelId] ??= {});
  for (const [metric, count] of Object.entries(periodCounts(savings))) {
    const key = metric as keyof SavingsCounts;
    counts[key] = (counts[key] ?? 0) + count;
  }
}

/**
 * Return the first day with counters that live recording wrote, if any. Days
 * that `replaceHistorySavings` wrote do not count.
 */
export async function firstLiveSavingsDate(): Promise<string | undefined> {
  return await firstStatDate(SAVINGS_NAMESPACE, METRICS.historyDays);
}

/**
 * Replace the counters of the UTC days from `start` up to `end`, not
 * included, with these sums from history. Each day that has sums gets a
 * `history_days` marker, so the System page knows that its warmup cost is
 * unknown and `firstLiveSavingsDate` skips it.
 */
export async function replaceHistorySavings(
  sums: HistorySavings,
  range: { start: string; end: string },
): Promise<void> {
  const days = Object.entries(sums).filter(
    ([date]) => date >= range.start && date < range.end,
  );
  await replaceStats(
    SAVINGS_NAMESPACE,
    range,
    days.flatMap(([date, byModel]) => [
      {
        namespace: SAVINGS_NAMESPACE,
        metric: METRICS.historyDays,
        name: "history",
        count: 1,
        date,
      },
      ...Object.entries(byModel).flatMap(([modelId, counts]) =>
        savingsStats(modelId, counts).map((stat) => ({ ...stat, date })),
      ),
    ]),
  );
}

/** Savings totals of a set of counters, in dollars. */
export interface SavingsTotals {
  /** Days filled from history, whose warmup cost is unknown. */
  historyDays: number;
  hits: number;
  idlePeriods: number;
  oracleSavingsUsd: number;
  savedUsd: number;
  unwarmedIdlePeriods: number;
  unwarmedOracleSavingsUsd: number;
  warmupCostUsd: number;
}

/** Sum the cache warming counters of these stats over all models. */
export function savingsTotals(stats: readonly Stat[]): SavingsTotals {
  const sum = (metric: string) =>
    stats
      .filter(
        (stat) =>
          stat.namespace === SAVINGS_NAMESPACE && stat.metric === metric,
      )
      .reduce((total, stat) => total + stat.count, 0);
  return {
    historyDays: sum(METRICS.historyDays),
    hits: sum(METRICS.hits),
    idlePeriods: sum(METRICS.idlePeriods),
    oracleSavingsUsd: sum(METRICS.oracleSavings) / UNITS_PER_USD,
    savedUsd: sum(METRICS.saved) / UNITS_PER_USD,
    unwarmedIdlePeriods: sum(METRICS.unwarmedIdlePeriods),
    unwarmedOracleSavingsUsd:
      sum(METRICS.unwarmedOracleSavings) / UNITS_PER_USD,
    warmupCostUsd: sum(METRICS.warmupCost) / UNITS_PER_USD,
  };
}
