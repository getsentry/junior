import type { CacheWarmingSavingsReport } from "@sentry/junior/api/schema";
import { NOW_MS } from "./fixtures";

const DAY_MS = 24 * 60 * 60 * 1_000;

// A fixed shape, so screenshots stay the same. A few days lose money.
function mockDay(index: number, date: string) {
  const idlePeriods = 30 + (index % 7) * 4;
  const hits = Math.round(idlePeriods * (0.35 + (index % 5) * 0.06));
  const savedUsd = hits * 0.29;
  const warmupCostUsd = 1.6 + (index % 4) * 0.7 + (index % 9 === 4 ? 6 : 0);
  const oracleSavingsUsd = idlePeriods * 0.27;
  const unwarmedIdlePeriods = 2 + (index % 3);
  return {
    date,
    hits,
    idlePeriods,
    netSavingsUsd: savedUsd - warmupCostUsd,
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
  const series = Array.from({ length: days }, (_, index) =>
    mockDay(
      index,
      new Date(NOW_MS - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10),
    ),
  );
  const sum = (key: Exclude<keyof (typeof series)[number], "date">) =>
    series.reduce((total, day) => total + day[key], 0);
  const totals = {
    hits: sum("hits"),
    idlePeriods: sum("idlePeriods"),
    netSavingsUsd: sum("netSavingsUsd"),
    oracleSavingsUsd: sum("oracleSavingsUsd"),
    savedUsd: sum("savedUsd"),
    unwarmedIdlePeriods: sum("unwarmedIdlePeriods"),
    unwarmedOracleSavingsUsd: sum("unwarmedOracleSavingsUsd"),
    warmupCostUsd: sum("warmupCostUsd"),
  };
  return {
    days: series,
    totals: {
      ...totals,
      effectiveness: totals.netSavingsUsd / totals.oracleSavingsUsd,
    },
  };
}
