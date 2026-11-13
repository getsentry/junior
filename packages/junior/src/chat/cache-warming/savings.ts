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
import { addStats, firstStatDate, type Stat } from "@/stats";
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
  /** Cache reads of the warmups that an ideal warmer sends for the gap. */
  idealWarmupCostUsd: number;
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
  const idealWarmupCostUsd = warmups * input.prefixTokens * read;
  const hit = input.cacheRead >= minTokens;
  return {
    hit,
    idealWarmupCostUsd,
    oracleUsd: writeSavedUsd - idealWarmupCostUsd,
    savedUsd: hit ? writeSavedUsd : 0,
  };
}

const units = (usd: number) => Math.round(usd * UNITS_PER_USD);

type Counts = Partial<Record<keyof typeof METRICS, number>>;

const savingsStats = (modelId: string, counts: Counts) =>
  Object.entries(counts).map(([metric, count]) => ({
    namespace: SAVINGS_NAMESPACE,
    metric: METRICS[metric as keyof typeof METRICS],
    name: modelId,
    count,
  }));

// Counter amounts of one idle period. `warmed` is unset for a period whose
// warm state is not known.
function periodCounts(savings: IdlePeriodSavings, warmed?: boolean): Counts {
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
async function addSavingsStats(modelId: string, counts: Counts): Promise<void> {
  if (!process.env.DATABASE_URL) return;
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

/** One idle period of stored history that `idlePeriodSavings` counted. */
export interface BackfilledSavings {
  /** Start of the call that ended the idle period. */
  endedAtMs: number;
  modelId: string;
  savings: IdlePeriodSavings;
}

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Add the counters of idle periods from stored history, only on days before
 * the first day that has counters, and before today when none has. Live
 * recording writes only today, so this never adds to a day that it wrote.
 *
 * History does not say whether a period had warm state, so these periods do
 * not count as unwarmed. History has no warmup calls either. On a hit, the
 * warmup cost is the ideal warmer's, the least that the warmer must have
 * sent to keep the cache. A miss adds no warmup cost. Return the days
 * written.
 */
export async function addBackfilledSavings(
  periods: readonly BackfilledSavings[],
  nowMs: number,
): Promise<string[]> {
  const firstDate = (await firstStatDate(SAVINGS_NAMESPACE)) ?? utcDate(nowMs);
  // Sums per day and model, so the statement writes each counter once.
  const byDate = new Map<string, Map<string, Counts>>();
  for (const { endedAtMs, modelId, savings } of periods) {
    const date = utcDate(endedAtMs);
    if (date >= firstDate) continue;
    const byModel = byDate.get(date) ?? new Map<string, Counts>();
    const sums = byModel.get(modelId) ?? {};
    const counts: Counts = {
      ...periodCounts(savings),
      warmupCost: savings.hit ? units(savings.idealWarmupCostUsd) : 0,
    };
    for (const [metric, count] of Object.entries(counts)) {
      const key = metric as keyof Counts;
      sums[key] = (sums[key] ?? 0) + count;
    }
    byModel.set(modelId, sums);
    byDate.set(date, byModel);
  }
  // One statement for every day. A run that stops after some days land would
  // make the oldest of them the first day with counters, and a retry would
  // then skip the days that did not land.
  await addStats(
    [...byDate].flatMap(([date, byModel]) =>
      [...byModel].flatMap(([modelId, counts]) =>
        savingsStats(modelId, counts).map((stat) => ({ ...stat, date })),
      ),
    ),
  );
  return [...byDate.keys()].sort();
}

/** Savings totals of a set of counters, in dollars. */
export interface SavingsTotals {
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
