/**
 * Named counters in `junior_stats` (daily) and `junior_hourly_stats`
 * (hourly, kept for `HOURLY_STATS_RETENTION_MS`).
 *
 * These tables hold only pre-aggregated counters with a small, fixed set of
 * keys: a name is a model, provider, reason, or similar label. They never
 * hold per-event rows or keys that grow with use, such as Conversation, run,
 * or user ids. Detail that needs those belongs in telemetry.
 */
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  min,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { juniorHourlyStats, juniorStats } from "@/db/schema";

const HOUR_MS = 60 * 60 * 1_000;
/**
 * How long hourly counters are kept: a week, and the week before it for
 * comparison, with a day to spare.
 */
export const HOURLY_STATS_RETENTION_MS = 15 * 24 * HOUR_MS;

export interface Stat {
  count: number;
  date: string;
  metric: string;
  name: string;
  namespace: string;
}

/** One hourly counter. `hour` is the ISO start of its UTC hour. */
export interface HourlyStat {
  count: number;
  hour: string;
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

/** Return the ISO start of the UTC hour of `ms`. */
export function utcHour(ms: number): string {
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString();
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
      set: {
        count: sql`${juniorStats.count} + excluded.${sql.identifier(juniorStats.count.name)}`,
      },
    });
}

/**
 * Add amounts to the hourly counters of the UTC hour of `nowMs` in one
 * statement. Zero amounts add no row.
 */
export async function addHourlyStats(
  amounts: Array<StatKey & { count: number }>,
  options: { nowMs?: number } = {},
): Promise<void> {
  const hour = new Date(utcHour(options.nowMs ?? Date.now()));
  const values = amounts
    .filter((amount) => amount.count !== 0)
    .map(({ namespace, metric, name, count }) => ({
      hour,
      namespace,
      metric,
      name,
      count,
    }));
  if (!values.length) return;
  await getDb()
    .insert(juniorHourlyStats)
    .values(values)
    .onConflictDoUpdate({
      target: [
        juniorHourlyStats.hour,
        juniorHourlyStats.namespace,
        juniorHourlyStats.metric,
        juniorHourlyStats.name,
      ],
      set: {
        count: sql`${juniorHourlyStats.count} + excluded.${sql.identifier(juniorHourlyStats.count.name)}`,
      },
    });
}

/**
 * Read the hourly counters of these namespaces in each range of epoch ms,
 * start included and end not, in one statement.
 */
export async function readHourlyStats(
  namespaces: readonly string[],
  ranges: ReadonlyArray<{ startMs: number; endMs: number }>,
): Promise<HourlyStat[]> {
  const rows = await getDb()
    .select({
      count: juniorHourlyStats.count,
      hour: juniorHourlyStats.hour,
      metric: juniorHourlyStats.metric,
      name: juniorHourlyStats.name,
      namespace: juniorHourlyStats.namespace,
    })
    .from(juniorHourlyStats)
    .where(
      and(
        inArray(juniorHourlyStats.namespace, [...namespaces]),
        or(
          ...ranges.map((range) =>
            and(
              gte(juniorHourlyStats.hour, new Date(range.startMs)),
              lt(juniorHourlyStats.hour, new Date(range.endMs)),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(juniorHourlyStats.hour));
  return rows.map((row) => ({ ...row, hour: row.hour.toISOString() }));
}

/** Delete the hourly counters older than `HOURLY_STATS_RETENTION_MS`. */
export async function pruneHourlyStats(nowMs: number): Promise<void> {
  await getDb()
    .delete(juniorHourlyStats)
    .where(
      lt(juniorHourlyStats.hour, new Date(nowMs - HOURLY_STATS_RETENTION_MS)),
    );
}

/** Read daily counters inside an inclusive UTC date range. */
export async function readStats(start: string, end: string): Promise<Stat[]> {
  return await getDb()
    .select({
      count: juniorStats.count,
      date: juniorStats.date,
      metric: juniorStats.metric,
      name: juniorStats.name,
      namespace: juniorStats.namespace,
    })
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
