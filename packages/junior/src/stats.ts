import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { juniorStats } from "@/db/schema";

export interface Stat {
  count: number;
  date: string;
  lastOccurredAtMs: number | null;
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

/** Increment one daily named counter. */
export async function incrementStat(
  key: StatKey,
  options: { nowMs?: number } = {},
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const date = utcDate(nowMs);
  await getDb()
    .insert(juniorStats)
    .values({ ...key, date, count: 1, lastOccurredAtMs: nowMs })
    .onConflictDoUpdate({
      target: [
        juniorStats.date,
        juniorStats.namespace,
        juniorStats.metric,
        juniorStats.name,
      ],
      set: {
        count: sql`${juniorStats.count} + 1`,
        lastOccurredAtMs: nowMs,
      },
    });
}

/** Read all daily counters for one namespace and metric. */
export async function readNamedStats(
  namespace: string,
  metric: string,
): Promise<Stat[]> {
  return await getDb()
    .select()
    .from(juniorStats)
    .where(
      and(eq(juniorStats.namespace, namespace), eq(juniorStats.metric, metric)),
    )
    .orderBy(asc(juniorStats.date), asc(juniorStats.name));
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
