import { readStats } from "@/stats";
import { statsReportSchema, type StatsReport } from "./schema/stats";

const WINDOW_DAYS = 90;

/** Read the last 90 days of named daily counters. */
export async function readStatsReport(): Promise<StatsReport> {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const startDate = new Date(now);
  startDate.setUTCHours(0, 0, 0, 0);
  startDate.setUTCDate(startDate.getUTCDate() - (WINDOW_DAYS - 1));
  const start = startDate.toISOString().slice(0, 10);

  return statsReportSchema.parse({
    generatedAt: now.toISOString(),
    stats: await readStats(start, end),
    windowEnd: end,
    windowStart: start,
  });
}
