import { and, asc, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { juniorStats } from "@/db/schema";

export interface Stat {
  count: number;
  date: string;
  metric: string;
  name: string;
  namespace: string;
}

export interface StatKey {
  metric: string;
  name: string;
  namespace: string;
}

function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// TODO: accept hour keys when junior_stats can store them for 24h workspace usage.
/** Increment one daily named counter. */
export async function incrementStat(
  key: StatKey,
  options: { nowMs?: number } = {},
): Promise<void> {
  const date = utcDate(options.nowMs ?? Date.now());
  await getDb()
    .insert(juniorStats)
    .values({ ...key, date, count: 1 })
    .onConflictDoUpdate({
      target: [
        juniorStats.date,
        juniorStats.namespace,
        juniorStats.metric,
        juniorStats.name,
      ],
      set: { count: sql`${juniorStats.count} + 1` },
    });
}

/** Read daily counters inside an inclusive UTC date range. */
export async function readStats(start: string, end: string): Promise<Stat[]> {
  return await getDb()
    .select()
    .from(juniorStats)
    .where(and(gte(juniorStats.date, start), lte(juniorStats.date, end)))
    .orderBy(
      asc(juniorStats.date),
      asc(juniorStats.namespace),
      asc(juniorStats.metric),
      asc(juniorStats.name),
    );
}
