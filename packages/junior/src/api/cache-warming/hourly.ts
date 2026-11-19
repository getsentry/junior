import {
  CACHE_WARMING_NAMESPACE,
  MODEL_CACHE_NAMESPACE,
  modelCacheTotals,
  warmupOutcomeTotals,
} from "@/chat/cache-warming/counters";
import type { BreakerState } from "@/chat/cache-warming/request";
import { savingsTotals } from "@/chat/cache-warming/savings";
import { microUsdToUsd } from "@/db/micro-usd";
import { readHourlyStats, type HourlyStat } from "@/stats";
import type { CacheWarmingHourlyReport } from "../schema/cache-warming";
import { netSavingsUsd, savingsUsd } from "./savings";

const HOUR_MS = 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

function savings(stats: readonly HourlyStat[]) {
  const totals = savingsTotals(stats);
  const net = netSavingsUsd(totals);
  const oracle = microUsdToUsd(totals.oracleSavingsMicroUsd);
  return {
    ...savingsUsd(totals),
    netSavingsUsd: net,
    effectiveness: oracle > 0 ? net / oracle : null,
  };
}

function warmups(stats: readonly HourlyStat[]) {
  const { sent, missed, warmedRewrites, skipped } = warmupOutcomeTotals(stats);
  return { sent, missed, warmedRewrites, skipped };
}

/**
 * Read the hourly cache warming report of the UTC hours from `startMs` up to
 * `endMs`: savings, warmup outcomes, and the prompt cache of agent model
 * calls, per hour and in total, with the prompt cache of the same window a
 * week earlier. Both windows come from one read.
 */
export async function readCacheWarmingHourly(
  window: { startMs: number; endMs: number },
  breakers: BreakerState[],
): Promise<CacheWarmingHourlyReport> {
  const lastWeek = {
    startMs: window.startMs - WEEK_MS,
    endMs: window.endMs - WEEK_MS,
  };
  const stats = await readHourlyStats(
    [CACHE_WARMING_NAMESPACE, MODEL_CACHE_NAMESPACE],
    [window, lastWeek],
  );
  const inWindow = (range: typeof window) => (stat: HourlyStat) => {
    const ms = Date.parse(stat.hour);
    return ms >= range.startMs && ms < range.endMs;
  };
  const current = stats.filter(inWindow(window));
  const byHour = new Map<string, HourlyStat[]>();
  for (const stat of current) {
    const list = byHour.get(stat.hour);
    if (list) list.push(stat);
    else byHour.set(stat.hour, [stat]);
  }
  const hours = Array.from(
    { length: (window.endMs - window.startMs) / HOUR_MS },
    (_, index) => new Date(window.startMs + index * HOUR_MS).toISOString(),
  );
  const outcomes = warmupOutcomeTotals(current);
  const models = [
    ...new Set(
      current
        .filter((stat) => stat.namespace === MODEL_CACHE_NAMESPACE)
        .map((stat) => stat.name),
    ),
  ].sort();
  return {
    start: new Date(window.startMs).toISOString(),
    end: new Date(window.endMs).toISOString(),
    hours: hours.map((hour) => {
      const hourStats = byHour.get(hour) ?? [];
      return {
        hour,
        savings: savings(hourStats),
        modelCache: modelCacheTotals(hourStats),
        warmups: warmups(hourStats),
      };
    }),
    totals: {
      savings: savings(current),
      modelCache: modelCacheTotals(current),
      modelCacheByModel: models.map((model) => ({
        model,
        ...modelCacheTotals(current.filter((stat) => stat.name === model)),
      })),
      warmups: {
        ...warmups(current),
        sentByTurnEnding: outcomes.sentByTurnEnding,
        skipReasons: outcomes.skipReasons,
      },
      breakerOpened: outcomes.breakerOpened,
      breakerClosed: outcomes.breakerClosed,
    },
    lastWeek: {
      start: new Date(lastWeek.startMs).toISOString(),
      end: new Date(lastWeek.endMs).toISOString(),
      modelCache: modelCacheTotals(stats.filter(inWindow(lastWeek))),
    },
    breakers,
  };
}
