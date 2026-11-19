import type {
  CacheWarmingHourlyReport,
  CacheWarmingSavingsReport,
} from "@sentry/junior/api/schema";
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

const HOUR_MS = 60 * 60 * 1_000;
const MOCK_MODEL = "anthropic/claude-opus-5.5";

// Prompt cache of one hour. Hours that end 13 to 15 hours before the window
// ends show a provider cache outage: most calls rewrite their prefix.
function mockModelCache(index: number, outage: boolean) {
  const calls = 20 + (index % 6) * 3;
  const fullRewrites = outage
    ? Math.round(calls * 0.6)
    : index % 9 === 2
      ? 1
      : 0;
  const inputTokens = calls * 120_000;
  const cacheWriteTokens = outage
    ? Math.round(inputTokens * 0.55)
    : Math.round(inputTokens * (0.05 + (index % 4) * 0.01));
  return {
    calls,
    fullRewrites,
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens: inputTokens - cacheWriteTokens - calls * 400,
    writeShare: cacheWriteTokens / inputTokens,
    fullRewriteRate: fullRewrites / calls,
  };
}

function mockHourSavings(index: number, outage: boolean) {
  const idlePeriods = 1 + (index % 3);
  const hits = outage ? 0 : Math.max(0, idlePeriods - (index % 2));
  const savedUsd = hits * 0.25;
  const warmupCostUsd = 0.05 + (index % 4) * 0.03;
  const oracleSavingsUsd = idlePeriods * 0.27;
  const netSavingsUsd = savedUsd - warmupCostUsd;
  return {
    idlePeriods,
    hits,
    savedUsd,
    warmupCostUsd,
    oracleSavingsUsd,
    unwarmedIdlePeriods: index % 5 === 0 ? 1 : 0,
    unwarmedOracleSavingsUsd: index % 5 === 0 ? 0.26 : 0,
    netSavingsUsd,
    effectiveness: netSavingsUsd / oracleSavingsUsd,
  };
}

const sumBy = <T extends Record<string, unknown>>(
  rows: readonly T[],
  key: keyof T,
) => rows.reduce((total, row) => total + Number(row[key]), 0);

function modelCacheTotal(rows: ReturnType<typeof mockModelCache>[]) {
  const calls = sumBy(rows, "calls");
  const fullRewrites = sumBy(rows, "fullRewrites");
  const inputTokens = sumBy(rows, "inputTokens");
  const cacheWriteTokens = sumBy(rows, "cacheWriteTokens");
  return {
    calls,
    fullRewrites,
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens: sumBy(rows, "cacheReadTokens"),
    writeShare: inputTokens ? cacheWriteTokens / inputTokens : null,
    fullRewriteRate: calls ? fullRewrites / calls : null,
  };
}

/** Return a fixed hourly cache warming report of the hours in the window. */
export function readMockCacheWarmingHourly(
  startMs: number,
  endMs: number,
): CacheWarmingHourlyReport {
  const count = (endMs - startMs) / HOUR_MS;
  const hours = Array.from({ length: count }, (_, index) => {
    const age = count - 1 - index;
    const outage = age >= 13 && age <= 15;
    const modelCache = mockModelCache(index, outage);
    const sent = outage ? 1 : 3 + (index % 4);
    return {
      hour: new Date(startMs + index * HOUR_MS).toISOString(),
      savings: mockHourSavings(index, outage),
      modelCache,
      warmups: {
        sent,
        missed: outage ? 1 : 0,
        warmedRewrites: outage ? 2 : index % 11 === 3 ? 1 : 0,
        skipped: outage ? 6 : 2 + (index % 3),
      },
    };
  });
  const savings = hours.map((hour) => hour.savings);
  const warmups = hours.map((hour) => hour.warmups);
  const netSavingsUsd = sumBy(savings, "netSavingsUsd");
  const oracleSavingsUsd = sumBy(savings, "oracleSavingsUsd");
  const sent = sumBy(warmups, "sent");
  const skipped = sumBy(warmups, "skipped");
  const modelCache = modelCacheTotal(hours.map((hour) => hour.modelCache));
  const breakerOpenedMs = endMs - 15 * HOUR_MS + 20 * 60 * 1_000;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    hours,
    totals: {
      savings: {
        idlePeriods: sumBy(savings, "idlePeriods"),
        hits: sumBy(savings, "hits"),
        savedUsd: sumBy(savings, "savedUsd"),
        warmupCostUsd: sumBy(savings, "warmupCostUsd"),
        oracleSavingsUsd,
        unwarmedIdlePeriods: sumBy(savings, "unwarmedIdlePeriods"),
        unwarmedOracleSavingsUsd: sumBy(savings, "unwarmedOracleSavingsUsd"),
        netSavingsUsd,
        effectiveness: netSavingsUsd / oracleSavingsUsd,
      },
      modelCache,
      modelCacheByModel: [{ ...modelCache, model: MOCK_MODEL }],
      warmups: {
        sent,
        missed: sumBy(warmups, "missed"),
        warmedRewrites: sumBy(warmups, "warmedRewrites"),
        skipped,
        sentByTurnEnding: {
          reply: Math.round(sent * 0.6),
          tool_wait: Math.round(sent * 0.25),
          no_reply: sent - Math.round(sent * 0.6) - Math.round(sent * 0.25),
        },
        skipReasons: {
          unlikely_return: Math.round(skipped * 0.5),
          horizon: Math.round(skipped * 0.3),
          breaker_open: 6,
          stopped:
            skipped - Math.round(skipped * 0.5) - Math.round(skipped * 0.3) - 6,
        },
      },
      breakerOpened: 1,
      breakerClosed: 0,
    },
    lastWeek: {
      start: new Date(startMs - 7 * 24 * HOUR_MS).toISOString(),
      end: new Date(endMs - 7 * 24 * HOUR_MS).toISOString(),
      modelCache: modelCacheTotal(
        hours.map((_, index) => mockModelCache(index, false)),
      ),
    },
    breakers: [
      {
        provider: "anthropic",
        open: false,
        lastOpenedAt: new Date(breakerOpenedMs).toISOString(),
        lastClosedAt: new Date(breakerOpenedMs + 30 * 60 * 1_000).toISOString(),
      },
    ],
  };
}
