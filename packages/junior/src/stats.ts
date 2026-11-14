import { and, asc, eq, gte, lt, lte, min, notInArray, sql } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
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
  await addStats([{ ...key, count: 1 }], options);
}

/**
 * Add amounts to daily named counters in one statement. An amount without a
 * `date` adds to the day of `nowMs`. Zero amounts add no row.
 */
export async function addStats(
  amounts: Array<StatKey & { count: number; date?: string }>,
  options: { nowMs?: number } = {},
): Promise<void> {
  const date = utcDate(options.nowMs ?? Date.now());
  const values = amounts
    .filter((amount) => amount.count !== 0)
    .map((amount) => ({ ...amount, date: amount.date ?? date }));
  if (!values.length) return;
  await getDb()
    .insert(juniorStats)
    .values(values)
    .onConflictDoUpdate({
      target: [
        juniorStats.date,
        juniorStats.namespace,
        juniorStats.metric,
        juniorStats.name,
      ],
      set: { count: sql`${juniorStats.count} + excluded.count` },
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

/**
 * Return the first day with a counter in the namespace, if any. Days that
 * have a `skipDatesWith` counter in the namespace do not count.
 */
export async function firstStatDate(
  namespace: string,
  skipDatesWith: string,
): Promise<string | undefined> {
  const skipped = getDb()
    .select({ date: juniorStats.date })
    .from(juniorStats)
    .where(
      and(
        eq(juniorStats.namespace, namespace),
        eq(juniorStats.metric, skipDatesWith),
      ),
    );
  const [row] = await getDb()
    .select({ date: min(juniorStats.date) })
    .from(juniorStats)
    .where(
      and(
        eq(juniorStats.namespace, namespace),
        notInArray(juniorStats.date, skipped),
      ),
    );
  return row?.date ?? undefined;
}

/**
 * Replace every counter of the namespace on the UTC days from `start` up to
 * `end`, not included, with these amounts, in one transaction.
 */
export async function replaceStats(
  namespace: string,
  range: { start: string; end: string },
  amounts: Array<StatKey & { count: number; date: string }>,
): Promise<void> {
  const executor = getSqlExecutor();
  await executor.transaction(async () => {
    await executor
      .db()
      .delete(juniorStats)
      .where(
        and(
          eq(juniorStats.namespace, namespace),
          gte(juniorStats.date, range.start),
          lt(juniorStats.date, range.end),
        ),
      );
    await addStats(amounts);
  });
}
