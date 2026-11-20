import type { CacheWarmingSavingsReport } from "@sentry/junior/api/schema";
import { NOW_MS } from "./fixtures";

const DAY_MS = 24 * 60 * 60 * 1_000;

// Days this old come from a history re-fill. Days older than warming have
// no counters.
const HISTORY_AGE_DAYS = 22;
const WARMING_AGE_DAYS = 26;

// A fixed shape, so screenshots stay the same. A few days lose money.
function mockDay(index: number, date: string, history: boolean) {
  const idlePeriods = 30 + (index % 7) * 4;
  const hits = Math.round(idlePeriods * (0.35 + (index % 5) * 0.06));
  const savedUsd = hits * 0.29;
  const warmupCostUsd = 1.6 + (index % 4) * 0.7 + (index % 9 === 4 ? 6 : 0);
  const oracleSavingsUsd = idlePeriods * 0.27;
  const unwarmedIdlePeriods = history ? 0 : 2 + (index % 3);
  return {
    date,
    hits,
    idlePeriods,
    history,
    netSavingsUsd: savedUsd - warmupCostUsd,
    oracleSavingsUsd,
    savedUsd,
    unwarmedIdlePeriods,
    unwarmedOracleSavingsUsd: unwarmedIdlePeriods * 0.26,
    warmupCostUsd,
  };
}

// A day before warming started: no counters.
function emptyDay(date: string): ReturnType<typeof mockDay> {
  return {
    date,
    hits: 0,
    idlePeriods: 0,
    history: false,
    netSavingsUsd: 0,
    oracleSavingsUsd: 0,
    savedUsd: 0,
    unwarmedIdlePeriods: 0,
    unwarmedOracleSavingsUsd: 0,
    warmupCostUsd: 0,
  };
}

/** Return fixed cache warming savings for the last `days` UTC days. */
export function readMockCacheWarmingSavings(
  days: number,
): CacheWarmingSavingsReport {
  const series = Array.from({ length: days }, (_, index) => {
    const age = days - 1 - index;
    const date = new Date(NOW_MS - age * DAY_MS).toISOString().slice(0, 10);
    return age >= WARMING_AGE_DAYS
      ? emptyDay(date)
      : mockDay(index, date, age >= HISTORY_AGE_DAYS);
  });
  const live = series.filter((day) => !day.history);
  const sum = (
    list: typeof series,
    key: Exclude<keyof (typeof series)[number], "date" | "history">,
  ) => list.reduce((total, day) => total + day[key], 0);
  const netSavingsUsd = sum(series, "netSavingsUsd");
  const oracleSavingsUsd = sum(series, "oracleSavingsUsd");
  return {
    days: series,
    totals: {
      hits: sum(series, "hits"),
      idlePeriods: sum(series, "idlePeriods"),
      netSavingsUsd,
      oracleSavingsUsd,
      savedUsd: sum(series, "savedUsd"),
      unwarmedIdlePeriods: sum(series, "unwarmedIdlePeriods"),
      unwarmedOracleSavingsUsd: sum(series, "unwarmedOracleSavingsUsd"),
      warmupCostUsd: sum(series, "warmupCostUsd"),
      liveOracleSavingsUsd: sum(live, "oracleSavingsUsd"),
      effectiveness: netSavingsUsd / oracleSavingsUsd,
      historyDays: series.length - live.length,
    },
  };
}
