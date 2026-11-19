import { and, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import { juniorGuardianReviewHours } from "@/db/schema";
import { microUsdSql, microUsdToUsd } from "@/db/micro-usd";
import {
  readConversationMetricBuckets,
  type ConversationMetricBucket,
} from "./metric-buckets";
import {
  outcomeBuckets,
  readBriefOutcomeRoots,
  readWindowMerges,
  readWindowRoots,
  type OutcomeBucket,
  type WindowRoot,
} from "./outcome-buckets";
import type {
  ConversationMetricDay,
  ConversationStatsReport,
  GuardianMetricDay,
  GuardianStats,
} from "../schema/conversation-stats";
import {
  WINDOW_SEVEN_DAY_HOURS,
  sumUtcHoursIntoSixHours,
  startOfUtcHour,
  utcHourKey,
} from "../reporting-window";

const WINDOW_DAYS = 90;

// Usage JSON keeps provider USD floats, and micro-USD converts to floats, so
// USD sums need rounding.
function addUsd(current: number | undefined, next: number): number {
  return Math.round(((current ?? 0) + next) * 1e12) / 1e12;
}

function statsWindow(nowMs: number) {
  const end = new Date(nowMs);
  const start = new Date(nowMs);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  return { end, start };
}

const HOUR_MS = 60 * 60 * 1_000;
/** Keep 7d of hours so clients can roll 7d charts into 6h buckets. */
const WINDOW_HOURS = WINDOW_SEVEN_DAY_HOURS;

type MetricRow = {
  cachedInputTokens: number | null;
  cacheCreationTokens: number | null;
  conversations: number;
  costUsd: number | null;
  date: string;
  durationMs: number;
  inputTokens: number | null;
  mergedCodeChangeCostUsd: number | null;
  mergedCodeChanges: number | null;
  outcomeCostUsd: number | null;
  outcomes: number | null;
  tokens: number | null;
};

function emptyMetricRow(date: string): MetricRow {
  return {
    cachedInputTokens: null,
    cacheCreationTokens: null,
    conversations: 0,
    costUsd: null,
    date,
    durationMs: 0,
    inputTokens: null,
    mergedCodeChangeCostUsd: null,
    mergedCodeChanges: null,
    outcomeCostUsd: null,
    outcomes: null,
    tokens: null,
  };
}

function applyMetricBuckets(
  rows: Array<Pick<MetricRow, "conversations" | "date">>,
  metrics: ConversationMetricBucket[],
  outcomes: OutcomeBucket[],
): MetricRow[] {
  const byDate = new Map<string, MetricRow>(
    rows.map((row) => [
      row.date,
      { ...emptyMetricRow(row.date), conversations: row.conversations },
    ]),
  );
  for (const bucket of outcomes) {
    const row = byDate.get(bucket.date) ?? emptyMetricRow(bucket.date);
    row.mergedCodeChanges = bucket.mergedCodeChanges;
    row.mergedCodeChangeCostUsd = bucket.mergedCodeChangeCostUsd;
    row.outcomes = bucket.outcomes;
    row.outcomeCostUsd = bucket.outcomeCostUsd;
    byDate.set(bucket.date, row);
  }
  for (const metric of metrics) {
    const row = byDate.get(metric.date) ?? emptyMetricRow(metric.date);
    if (metric.metric === "cached_input_tokens") {
      row.cachedInputTokens = metric.value;
    } else if (metric.metric === "cache_creation_tokens") {
      row.cacheCreationTokens = metric.value;
    } else if (metric.metric === "cost_micro_usd") {
      row.costUsd = microUsdToUsd(metric.value);
    } else if (metric.metric === "duration_ms") {
      row.durationMs = metric.value;
    } else if (metric.metric === "input_tokens") {
      row.inputTokens = metric.value;
    } else if (metric.metric === "total_tokens") {
      row.tokens = metric.value;
    }
    byDate.set(metric.date, row);
  }
  return [...byDate.values()];
}

type GuardianRow = {
  allow: number;
  ask: number;
  costUsd: number | null;
  date: string;
  deny: number;
  requests: number;
};

function metricPoint(
  date: string,
  row:
    | {
        cachedInputTokens?: number | null;
        cacheCreationTokens?: number | null;
        conversations?: number;
        costUsd?: number | null;
        durationMs?: number;
        inputTokens?: number | null;
        mergedCodeChangeCostUsd?: number | null;
        mergedCodeChanges?: number | null;
        outcomeCostUsd?: number | null;
        outcomes?: number | null;
        tokens?: number | null;
      }
    | undefined,
): ConversationMetricDay {
  return {
    conversations: row?.conversations ?? 0,
    date,
    durationMs: row?.durationMs ?? 0,
    ...(row?.cachedInputTokens !== null && row?.cachedInputTokens !== undefined
      ? { cachedInputTokens: row.cachedInputTokens }
      : undefined),
    ...(row?.cacheCreationTokens !== null &&
    row?.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: row.cacheCreationTokens }
      : undefined),
    ...(row?.costUsd !== null && row?.costUsd !== undefined
      ? { costUsd: row.costUsd }
      : undefined),
    ...(row?.inputTokens !== null && row?.inputTokens !== undefined
      ? { inputTokens: row.inputTokens }
      : undefined),
    ...(row?.outcomes !== null && row?.outcomes !== undefined
      ? {
          mergedCodeChangeCostUsd: addUsd(
            undefined,
            row.mergedCodeChangeCostUsd ?? 0,
          ),
          mergedCodeChanges: row.mergedCodeChanges ?? 0,
          outcomeCostUsd: addUsd(undefined, row.outcomeCostUsd ?? 0),
          outcomes: row.outcomes,
        }
      : undefined),
    ...(row?.tokens !== null && row?.tokens !== undefined
      ? { tokens: row.tokens }
      : undefined),
  };
}

function metricDays(rows: MetricRow[], endMs: number): ConversationMetricDay[] {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const end = new Date(endMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  const days: ConversationMetricDay[] = [];
  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    days.push(metricPoint(date, byDate.get(date)));
  }
  return days;
}

function emptyMetricDay(date: string): ConversationMetricDay {
  return { conversations: 0, date, durationMs: 0 };
}

function emptyGuardianDay(date: string): GuardianMetricDay {
  return { allow: 0, ask: 0, date, deny: 0, requests: 0 };
}

function sumMetricHoursIntoSixHours(
  hours: ConversationMetricDay[],
  endMs: number,
): ConversationMetricDay[] {
  return sumUtcHoursIntoSixHours({
    empty: emptyMetricDay,
    hours,
    nowMs: endMs,
  });
}

function sumGuardianHoursIntoSixHours(
  hours: GuardianMetricDay[],
  endMs: number,
): GuardianMetricDay[] {
  return sumUtcHoursIntoSixHours({
    empty: emptyGuardianDay,
    hours,
    nowMs: endMs,
  });
}

function metricHours(
  rows: MetricRow[],
  endMs: number,
): ConversationMetricDay[] {
  const byHour = new Map(rows.map((row) => [row.date, row]));
  const end = startOfUtcHour(endMs);
  const start = new Date(end.getTime() - (WINDOW_HOURS - 1) * HOUR_MS);
  const hours: ConversationMetricDay[] = [];
  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setTime(cursor.getTime() + HOUR_MS)
  ) {
    const date = utcHourKey(cursor);
    hours.push(metricPoint(date, byHour.get(date)));
  }
  return hours;
}

function guardianPoint(
  date: string,
  row: GuardianRow | undefined,
): GuardianMetricDay {
  return {
    allow: row?.allow ?? 0,
    ask: row?.ask ?? 0,
    date,
    deny: row?.deny ?? 0,
    requests: row?.requests ?? 0,
    ...(row?.costUsd !== null && row?.costUsd !== undefined
      ? { costUsd: addUsd(undefined, row.costUsd) }
      : undefined),
  };
}

function guardianStats(
  dayRows: GuardianRow[],
  hourRows: GuardianRow[],
  endMs: number,
): GuardianStats {
  const byDate = new Map(dayRows.map((row) => [row.date, row]));
  const end = new Date(endMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  const metricDays: GuardianMetricDay[] = [];
  let allow = 0;
  let ask = 0;
  let deny = 0;
  let requests = 0;
  let costUsd: number | undefined;

  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    const row = byDate.get(date);
    allow += row?.allow ?? 0;
    ask += row?.ask ?? 0;
    deny += row?.deny ?? 0;
    requests += row?.requests ?? 0;
    if (row?.costUsd !== null && row?.costUsd !== undefined) {
      costUsd = addUsd(costUsd, row.costUsd);
    }
    metricDays.push(guardianPoint(date, row));
  }

  const byHour = new Map(hourRows.map((row) => [row.date, row]));
  const hourEnd = startOfUtcHour(endMs);
  const hourStart = new Date(hourEnd.getTime() - (WINDOW_HOURS - 1) * HOUR_MS);
  const metricHours: GuardianMetricDay[] = [];
  for (
    const cursor = new Date(hourStart);
    cursor.getTime() <= hourEnd.getTime();
    cursor.setTime(cursor.getTime() + HOUR_MS)
  ) {
    const date = utcHourKey(cursor);
    metricHours.push(guardianPoint(date, byHour.get(date)));
  }

  return {
    allow,
    ask,
    deny,
    metricDays,
    metricHours,
    metricSixHours: sumGuardianHoursIntoSixHours(metricHours, endMs),
    requests,
    ...(costUsd !== undefined ? { costUsd } : undefined),
  };
}

/** Sum hour rows into UTC day rows, one per day and `key`. */
function sumHoursIntoDays<T extends { date: string }>(
  hours: readonly T[],
  add: (day: T, hour: T) => void,
  key: (hour: T) => string = () => "",
): T[] {
  const days = new Map<string, T>();
  for (const hour of hours) {
    const date = hour.date.slice(0, 10);
    const dayKey = `${date}:${key(hour)}`;
    const day = days.get(dayKey);
    if (day) add(day, hour);
    else days.set(dayKey, { ...hour, date });
  }
  return [...days.values()];
}

/** Count the window roots that have a tree, per UTC hour of last activity. */
function activityHours(roots: readonly WindowRoot[]) {
  const hours = new Map<string, { conversations: number; date: string }>();
  for (const root of roots) {
    if (root.treeConversations === 0) continue;
    const date = root.lastActivityAt.toISOString().slice(0, 13);
    const hour = hours.get(date);
    if (hour) hour.conversations += 1;
    else hours.set(date, { conversations: 1, date });
  }
  return [...hours.values()];
}

async function readGuardianHours(
  db: JuniorDatabase,
  start: Date,
  end: Date,
): Promise<GuardianRow[]> {
  const hours = juniorGuardianReviewHours;
  const hour = sql<string>`TO_CHAR(
    ${hours.hour} AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24'
  )`;
  const reviews = (decision: string) =>
    sql<number>`COALESCE(SUM(${hours.reviews}) FILTER (WHERE ${hours.decision} = ${decision}), 0)::integer`;
  const rows = await db
    .select({
      allow: reviews("allow"),
      ask: reviews("ask"),
      costMicroUsd: microUsdSql(sql`SUM(${hours.costMicroUsd})`),
      date: hour,
      deny: reviews("deny"),
      requests: sql<number>`SUM(${hours.reviews})::integer`,
    })
    .from(hours)
    .where(and(gte(hours.hour, start), lte(hours.hour, end)))
    .groupBy(hours.hour);
  return rows.map(({ costMicroUsd, ...row }) => ({
    ...row,
    costUsd: costMicroUsd === null ? null : microUsdToUsd(costMicroUsd),
  }));
}

/** Build complete 90-day dashboard stats from normalized durable SQL records. */
export async function readConversationStatsFromSql(): Promise<ConversationStatsReport> {
  const nowMs = Date.now();
  const { end, start } = statsWindow(nowMs);
  const db = getDb();
  // One hour-grained read per aggregate. Days and six-hour buckets are sums
  // of these hours.
  const [windowRoots, metrics, merges, briefRoots, guardian] =
    await Promise.all([
      readWindowRoots(db, { start, end }),
      readConversationMetricBuckets(db, { start, end }),
      readWindowMerges(db, { start, end }),
      readBriefOutcomeRoots(db, { start, end }),
      readGuardianHours(db, start, end),
    ]);
  const activity = activityHours(windowRoots);
  const outcomes = outcomeBuckets({ briefRoots, merges, windowRoots });
  const hours = metricHours(
    applyMetricBuckets(activity, metrics, outcomes),
    nowMs,
  );
  return {
    generatedAt: new Date(nowMs).toISOString(),
    guardian: guardianStats(
      sumHoursIntoDays(guardian, (day, hour) => {
        day.allow += hour.allow;
        day.ask += hour.ask;
        day.deny += hour.deny;
        day.requests += hour.requests;
        if (hour.costUsd !== null)
          day.costUsd = (day.costUsd ?? 0) + hour.costUsd;
      }),
      guardian,
      nowMs,
    ),
    metricDays: metricDays(
      applyMetricBuckets(
        sumHoursIntoDays(activity, (day, hour) => {
          day.conversations += hour.conversations;
        }),
        // Sum whole units before `applyMetricBuckets` converts micro-USD.
        sumHoursIntoDays(
          metrics,
          (day, hour) => {
            day.value += hour.value;
          },
          (bucket) => bucket.metric,
        ),
        sumHoursIntoDays(outcomes, (day, hour) => {
          day.mergedCodeChangeCostUsd += hour.mergedCodeChangeCostUsd;
          day.mergedCodeChanges += hour.mergedCodeChanges;
          day.outcomeCostUsd += hour.outcomeCostUsd;
          day.outcomes += hour.outcomes;
        }),
      ),
      nowMs,
    ),
    metricHours: hours,
    metricSixHours: sumMetricHoursIntoSixHours(hours, nowMs),
    source: "conversation_index",
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}
