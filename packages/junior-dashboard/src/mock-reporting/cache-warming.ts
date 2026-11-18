import type { CacheWarmingSavingsReport } from "@sentry/junior/api/schema";
import { NOW_MS } from "./fixtures";

const DAY_MS = 24 * 60 * 60 * 1_000;

// Days this old come from a history re-fill, with no warmup cost.
const HISTORY_AGE_DAYS = 22;

// A fixed shape, so screenshots stay the same. A few days lose money.
function mockDay(index: number, date: string, history: boolean) {
  const idlePeriods = 30 + (index % 7) * 4;
  const hits = Math.round(idlePeriods * (0.35 + (index % 5) * 0.06));
  const savedUsd = hits * 0.29;
  const warmupCostUsd = history
    ? 0
    : 1.6 + (index % 4) * 0.7 + (index % 9 === 4 ? 6 : 0);
  const oracleSavingsUsd = idlePeriods * 0.27;
  const unwarmedIdlePeriods = history ? 0 : 2 + (index % 3);
  return {
    date,
    hits,
    idlePeriods,
    netSavingsUsd: history ? null : savedUsd - warmupCostUsd,
    oracleSavingsUsd,
    savedUsd,
    unwarmedIdlePeriods,
    unwarmedOracleSavingsUsd: unwarmedIdlePeriods * 0.26,
    warmupCostUsd,
  };
}

/** Return fixed cache warming savings for the last `days` UTC days. */
export function readMockCacheWarmingSavings(
  days: number,
): CacheWarmingSavingsReport {
  const series = Array.from({ length: days }, (_, index) => {
    const age = days - 1 - index;
    return mockDay(
      index,
      new Date(NOW_MS - age * DAY_MS).toISOString().slice(0, 10),
      age >= HISTORY_AGE_DAYS,
    );
  });
  const known = series.filter((day) => day.netSavingsUsd !== null);
  const sum = (
    list: typeof series,
    key: Exclude<keyof (typeof series)[number], "date" | "netSavingsUsd">,
  ) => list.reduce((total, day) => total + day[key], 0);
  const netSavingsUsd = sum(known, "savedUsd") - sum(known, "warmupCostUsd");
  const knownCostOracleSavingsUsd = sum(known, "oracleSavingsUsd");
  return {
    days: series,
    totals: {
      hits: sum(series, "hits"),
      idlePeriods: sum(series, "idlePeriods"),
      netSavingsUsd,
      oracleSavingsUsd: sum(series, "oracleSavingsUsd"),
      savedUsd: sum(series, "savedUsd"),
      unwarmedIdlePeriods: sum(series, "unwarmedIdlePeriods"),
      unwarmedOracleSavingsUsd: sum(series, "unwarmedOracleSavingsUsd"),
      warmupCostUsd: sum(series, "warmupCostUsd"),
      knownCostOracleSavingsUsd,
      effectiveness: netSavingsUsd / knownCostOracleSavingsUsd,
      unknownCostDays: series.length - known.length,
    },
  };
}
