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
import { metrics } from "@/chat/sentry";
import { usdToMicroUsd } from "@/db/micro-usd";
import { addStats, firstStatDate, replaceStats, type Stat } from "@/stats";
import {
  MIN_WARMUP_PREFIX_TOKENS,
  WARMUP_MARGIN_MS,
  warmupPrice,
} from "./model";

/** `junior_stats` namespace of the cache warming counters. */
export const SAVINGS_NAMESPACE = "cache_warming";
// Dollar counters store whole micro-USD.
const METRICS = {
  hits: "hits",
  idlePeriods: "idle_periods",
  oracleSavings: "oracle_savings_micro_usd",
  saved: "saved_micro_usd",
  unwarmedIdlePeriods: "unwarmed_idle_periods",
  unwarmedOracleSavings: "unwarmed_oracle_savings_micro_usd",
  warmupCost: "warmup_cost_micro_usd",
  historyDays: "history_days",
} as const;
// The provider starts its TTL clock a few seconds after the request starts.
// Reads still hit until about 310s after a request with a 300s TTL.
const TTL_START_DELAY_MS = 10_000;
// A call that read at least this share of the prefix hit the cache. A call
// whose cached tokens are below it had a smaller context, as after compaction,
// or no usage.
const PREFIX_SHARE = 0.5;

// Warmups that keep the cache until a return `gapMs` after the request that
// started the idle period. Each one keeps it for one more TTL, less the warmup
// margin. None when the cache lives through the gap.
function warmupsNeeded(input: { cacheTtlMs: number; gapMs: number }): number {
  const lateMs = input.gapMs - input.cacheTtlMs - TTL_START_DELAY_MS;
  return lateMs <= 0
    ? 0
    : Math.ceil(lateMs / (input.cacheTtlMs - WARMUP_MARGIN_MS));
}

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
  const warmups = warmupsNeeded(input);
  if (warmups <= 0) return undefined;
  const minTokens = PREFIX_SHARE * input.prefixTokens;
  if (input.cacheRead + input.cacheWrite < minTokens) return undefined;
  const read = input.cacheReadPrice / 1_000_000;
  const write = input.cacheWritePrice / 1_000_000;
  // A warmup costs what the stop rule prices it at, a bit more than a read.
  const warmup = warmupPrice(read);
  if (warmups * warmup >= write - read) return undefined;
  const writeSavedUsd = input.prefixTokens * (write - read);
  const hit = input.cacheRead >= minTokens;
  return {
    hit,
    oracleUsd: writeSavedUsd - warmups * input.prefixTokens * warmup,
    savedUsd: hit ? writeSavedUsd : 0,
  };
}

/**
 * Return the savings of an idle period from stored history, as
 * `idlePeriodSavings` counts them. History has the warmup calls but not the
 * warm state. So a hit saves the write only when a warmup call ran in the
 * period and the return came before the cache of that warmup expired. Any
 * other hit read a cache that lived without warming, so it is not a hit.
 */
export function historyPeriodSavings(
  input: Parameters<typeof idlePeriodSavings>[0] & {
    /** Time from the last warmup call in the period to the return. */
    sinceLastWarmupMs?: number;
  },
): IdlePeriodSavings | undefined {
  const savings = idlePeriodSavings(input);
  if (!savings) return undefined;
  const reached =
    input.sinceLastWarmupMs !== undefined &&
    input.sinceLastWarmupMs <= input.cacheTtlMs + TTL_START_DELAY_MS;
  return reached ? savings : { ...savings, hit: false, savedUsd: 0 };
}

/**
 * What happened to an idle period that counts. `stopped_early`: warmups
 * stopped before the return, so its cache expired. `cache_lost`: the warmups
 * reached the return, but the provider no longer had the cache.
 */
export type IdlePeriodOutcome =
  | "saved"
  | "not_warmed"
  | "stopped_early"
  | "cache_lost";

/**
 * Return the outcome of an idle period that `idlePeriodSavings` counted.
 * `warmups` is the count of warmups that refreshed its cache.
 */
export function idlePeriodOutcome(
  input: { cacheTtlMs: number; gapMs: number },
  savings: IdlePeriodSavings,
  warmups: number,
): IdlePeriodOutcome {
  if (savings.hit) return "saved";
  if (warmups === 0) return "not_warmed";
  return warmups < warmupsNeeded(input) ? "stopped_early" : "cache_lost";
}

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
  const oracle = usdToMicroUsd(savings.oracleUsd);
  return {
    idlePeriods: 1,
    hits: savings.hit ? 1 : 0,
    oracleSavings: oracle,
    saved: usdToMicroUsd(savings.savedUsd),
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
 *
 * The System page reads the outcomes of recent periods from the unsampled
 * `cache_warming.idle_period.saved_usd` metric: one value per period, with
 * its outcome. The daily counters stay in Postgres.
 */
export async function recordIdlePeriodSavings(
  modelId: string,
  savings: IdlePeriodSavings,
  period: { warmed: boolean; outcome: IdlePeriodOutcome },
): Promise<void> {
  metrics.distribution(
    "cache_warming.idle_period.saved_usd",
    savings.savedUsd,
    {
      attributes: {
        "app.cache_warming.idle_outcome": period.outcome,
        "gen_ai.request.model": modelId,
      },
    },
  );
  await addSavingsStats(modelId, periodCounts(savings, period.warmed));
}

/** Add the cost of one warmup call. */
export async function recordWarmupCost(
  modelId: string,
  costUsd: number,
): Promise<void> {
  await addSavingsStats(modelId, { warmupCost: usdToMicroUsd(costUsd) });
}

/**
 * Counter sums of idle periods from stored history, per UTC day and model.
 * Plain JSON, so a job can keep them in state between slices.
 */
export type HistorySavings = Record<string, Record<string, SavingsCounts>>;

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Counter name of history amounts that have no model, such as the recorded
// warmup cost.
const HISTORY_NAME = "history";

/**
 * Add one idle period from stored history that `historyPeriodSavings`
 * counted, on the day of `endedAtMs`, the start of the call that ended it.
 *
 * History does not say whether a period had warm state, so it does not count
 * as unwarmed.
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
 * Add the recorded cost of the warmup calls of one day of history. The cost
 * events have no model.
 */
export function addHistoryWarmupCost(
  sums: HistorySavings,
  date: string,
  costUsd: number,
): void {
  const counts = ((sums[date] ??= {})[HISTORY_NAME] ??= {});
  counts.warmupCost = (counts.warmupCost ?? 0) + usdToMicroUsd(costUsd);
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
 * `history_days` marker, so the System page marks it and
 * `firstLiveSavingsDate` skips it.
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
        name: HISTORY_NAME,
        count: 1,
        date,
      },
      ...Object.entries(byModel).flatMap(([modelId, counts]) =>
        savingsStats(modelId, counts).map((stat) => ({ ...stat, date })),
      ),
    ]),
  );
}

/** Savings totals of a set of counters. Dollar totals are in micro-USD. */
export interface SavingsTotals {
  /** Days filled from history. */
  historyDays: number;
  hits: number;
  idlePeriods: number;
  oracleSavingsMicroUsd: number;
  savedMicroUsd: number;
  unwarmedIdlePeriods: number;
  unwarmedOracleSavingsMicroUsd: number;
  warmupCostMicroUsd: number;
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
    oracleSavingsMicroUsd: sum(METRICS.oracleSavings),
    savedMicroUsd: sum(METRICS.saved),
    unwarmedIdlePeriods: sum(METRICS.unwarmedIdlePeriods),
    unwarmedOracleSavingsMicroUsd: sum(METRICS.unwarmedOracleSavings),
    warmupCostMicroUsd: sum(METRICS.warmupCost),
  };
}
