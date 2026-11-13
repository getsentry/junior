import { SAVINGS_NAMESPACE, savingsTotals } from "@/chat/cache-warming/savings";
import { readStats, type Stat } from "@/stats";
import {
  cacheWarmingSavingsReportSchema,
  type CacheWarmingSavingsReport,
} from "../schema/cache-warming";

const DAY_MS = 24 * 60 * 60 * 1_000;

function savings(stats: readonly Stat[]) {
  const totals = savingsTotals(stats);
  return {
    ...totals,
    netSavingsUsd: totals.savedUsd - totals.warmupCostUsd,
  };
}

/**
 * Read what cache warming saved on each of the last `days` UTC days, today
 * included, and in total.
 */
export async function readCacheWarmingSavings(
  days: number,
  nowMs = Date.now(),
): Promise<CacheWarmingSavingsReport> {
  const dates = Array.from({ length: days }, (_, index) =>
    new Date(nowMs - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10),
  );
  const stats = (await readStats(dates[0]!, dates.at(-1)!)).filter(
    (stat) => stat.namespace === SAVINGS_NAMESPACE,
  );
  const totals = savings(stats);
  return cacheWarmingSavingsReportSchema.parse({
    days: dates.map((date) => ({
      date,
      ...savings(stats.filter((stat) => stat.date === date)),
    })),
    totals: {
      ...totals,
      effectiveness:
        totals.oracleSavingsUsd > 0
          ? totals.netSavingsUsd / totals.oracleSavingsUsd
          : null,
    },
  });
}
