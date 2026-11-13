import { SAVINGS_NAMESPACE, savingsTotals } from "@/chat/cache-warming/savings";
import { readStats, type Stat } from "@/stats";
import {
  cacheWarmingSavingsReportSchema,
  type CacheWarmingSavingsReport,
} from "../schema/cache-warming";

const DAY_MS = 24 * 60 * 60 * 1_000;

function savings(stats: readonly Stat[]) {
  const { historyDays: _, ...totals } = savingsTotals(stats);
  return totals;
}

/**
 * Read what cache warming saved on each of the last `days` UTC days, today
 * included, and in total. Net savings and effectiveness leave out days filled
 * from history: history has no warmup calls, so their warmup cost is unknown.
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
  const unknownCostDates = new Set(
    dates.filter(
      (date) =>
        savingsTotals(stats.filter((stat) => stat.date === date)).historyDays >
        0,
    ),
  );
  const known = savings(
    stats.filter((stat) => !unknownCostDates.has(stat.date)),
  );
  const netSavingsUsd = known.savedUsd - known.warmupCostUsd;
  return cacheWarmingSavingsReportSchema.parse({
    days: dates.map((date) => {
      const day = savings(stats.filter((stat) => stat.date === date));
      return {
        date,
        ...day,
        netSavingsUsd: unknownCostDates.has(date)
          ? null
          : day.savedUsd - day.warmupCostUsd,
      };
    }),
    totals: {
      ...savings(stats),
      netSavingsUsd,
      knownCostOracleSavingsUsd: known.oracleSavingsUsd,
      effectiveness:
        known.oracleSavingsUsd > 0
          ? netSavingsUsd / known.oracleSavingsUsd
          : null,
      unknownCostDays: unknownCostDates.size,
    },
  });
}
