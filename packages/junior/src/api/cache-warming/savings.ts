import {
  SAVINGS_NAMESPACE,
  savingsTotals,
  type SavingsTotals,
} from "@/chat/cache-warming/savings";
import { microUsdToUsd } from "@/db/micro-usd";
import { readStats } from "@/stats";
import {
  cacheWarmingSavingsReportSchema,
  type CacheWarmingSavingsReport,
} from "../schema/cache-warming";

const DAY_MS = 24 * 60 * 60 * 1_000;

// Dollar fields of the report, converted once from micro-USD.
function savingsUsd(totals: SavingsTotals) {
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

function netSavingsUsd(totals: SavingsTotals): number {
  return microUsdToUsd(totals.savedMicroUsd - totals.warmupCostMicroUsd);
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
  const known = savingsTotals(
    stats.filter((stat) => !unknownCostDates.has(stat.date)),
  );
  const knownNetSavingsUsd = netSavingsUsd(known);
  const knownOracleSavingsUsd = microUsdToUsd(known.oracleSavingsMicroUsd);
  return cacheWarmingSavingsReportSchema.parse({
    days: dates.map((date) => {
      const day = savingsTotals(stats.filter((stat) => stat.date === date));
      return {
        date,
        ...savingsUsd(day),
        netSavingsUsd: unknownCostDates.has(date) ? null : netSavingsUsd(day),
      };
    }),
    totals: {
      ...savingsUsd(savingsTotals(stats)),
      netSavingsUsd: knownNetSavingsUsd,
      knownCostOracleSavingsUsd: knownOracleSavingsUsd,
      effectiveness:
        knownOracleSavingsUsd > 0
          ? knownNetSavingsUsd / knownOracleSavingsUsd
          : null,
      unknownCostDays: unknownCostDates.size,
    },
  });
}
