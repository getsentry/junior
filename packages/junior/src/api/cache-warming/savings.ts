import { CACHE_WARMING_NAMESPACE } from "@/chat/cache-warming/counters";
import {
  savingsTotals,
  type SavingsTotals,
} from "@/chat/cache-warming/savings";
import { microUsdToUsd } from "@/db/micro-usd";
import { readStats } from "@/stats";
import { type CacheWarmingSavingsReport } from "../schema/cache-warming";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Dollar fields of a savings report, converted once from micro-USD. */
export function savingsUsd(totals: SavingsTotals) {
  return {
    hits: totals.hits,
    idlePeriods: totals.idlePeriods,
    oracleSavingsUsd: microUsdToUsd(totals.oracleSavingsMicroUsd),
    savedUsd: microUsdToUsd(totals.savedMicroUsd),
    unwarmedIdlePeriods: totals.unwarmedIdlePeriods,
    unwarmedOracleSavingsUsd: microUsdToUsd(
      totals.unwarmedOracleSavingsMicroUsd,
    ),
    warmupCostUsd: microUsdToUsd(totals.warmupCostMicroUsd),
  };
}

/** Saved writes less warmup cost, in dollars. */
export function netSavingsUsd(totals: SavingsTotals): number {
  return microUsdToUsd(totals.savedMicroUsd - totals.warmupCostMicroUsd);
}

/**
 * Read what cache warming saved on each of the last `days` UTC days, today
 * included, and in total. Days filled from history are marked: their saved
 * writes come from the replay and their warmup cost from the recorded warmup
 * calls.
 */
export async function readCacheWarmingSavings(
  days: number,
  nowMs = Date.now(),
): Promise<CacheWarmingSavingsReport> {
  const dates = Array.from({ length: days }, (_, index) =>
    new Date(nowMs - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10),
  );
  const stats = (await readStats(dates[0]!, dates.at(-1)!)).filter(
    (stat) => stat.namespace === CACHE_WARMING_NAMESPACE,
  );
  const dayTotals = dates.map((date) => ({
    date,
    totals: savingsTotals(stats.filter((stat) => stat.date === date)),
  }));
  const historyDates = new Set(
    dayTotals
      .filter((day) => day.totals.historyDays > 0)
      .map((day) => day.date),
  );
  const all = savingsTotals(stats);
  const net = netSavingsUsd(all);
  const oracle = microUsdToUsd(all.oracleSavingsMicroUsd);
  const live = savingsTotals(
    stats.filter((stat) => !historyDates.has(stat.date)),
  );
  return {
    days: dayTotals.map(({ date, totals }) => ({
      date,
      ...savingsUsd(totals),
      netSavingsUsd: netSavingsUsd(totals),
      history: historyDates.has(date),
    })),
    totals: {
      ...savingsUsd(all),
      netSavingsUsd: net,
      liveOracleSavingsUsd: microUsdToUsd(live.oracleSavingsMicroUsd),
      effectiveness: oracle > 0 ? net / oracle : null,
      historyDays: historyDates.size,
    },
  };
}
