import { gte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type {
  ActorDirectoryReport,
  ActorDirectoryWindows,
  ActorIdentity,
  ActorSummaryReport,
  ActorWindowMetrics,
  PeopleActivityDayReport,
} from "../schema/person";
import {
  personTurns,
  turnAggregateColumns,
  turnBucket,
  turnPersonColumns,
  turnRoot,
  turnRootJoin,
} from "./shared";
import {
  DAY_MS,
  HOUR_MS,
  WINDOW_SEVEN_DAY_HOURS,
  fillUtcDays,
  fillUtcHours,
  fillUtcSixHours,
  trailingUtcDayWindow,
  trailingUtcHourWindow,
  trailingUtcSixHourWindow,
  utcDayKey,
  utcHourKey,
} from "../reporting-window";

const DIRECTORY_ACTIVITY_DAYS = 90;
/** Day ranges need the prior equal period too (90d + prior 90d). */
const DAY_METRIC_LOOKBACK = 180;
/** Hour range needs the prior 24h too. */
const HOUR_METRIC_LOOKBACK = 48;
const DIRECTORY_RANGES = [1, 7, 30, 90] as const;

type MetricBucket = {
  costUsd: number;
  durationMs: number;
};

type Range = (typeof DIRECTORY_RANGES)[number];

function emptyDirectoryDay(date: string): PeopleActivityDayReport {
  return { activePeople: 0, conversations: 0, date };
}

function emptyBucket(): MetricBucket {
  return { costUsd: 0, durationMs: 0 };
}

function addUsd(current: number, next: number): number {
  return Math.round((current + next) * 1e12) / 1e12;
}

function directoryActivityDays(
  rows: PeopleActivityDayReport[],
  nowMs: number,
): PeopleActivityDayReport[] {
  return fillUtcDays({
    count: DIRECTORY_ACTIVITY_DAYS,
    empty: emptyDirectoryDay,
    nowMs,
    rows: new Map(rows.map((row) => [row.date, row])),
  });
}

function directoryActivityHours(
  rows: PeopleActivityDayReport[],
  nowMs: number,
): PeopleActivityDayReport[] {
  return fillUtcHours({
    count: WINDOW_SEVEN_DAY_HOURS,
    empty: emptyDirectoryDay,
    nowMs,
    rows: new Map(rows.map((row) => [row.date, row])),
  });
}

function directoryActivitySixHours(
  rows: PeopleActivityDayReport[],
  nowMs: number,
): PeopleActivityDayReport[] {
  return fillUtcSixHours({
    empty: emptyDirectoryDay,
    nowMs,
    rows: new Map(rows.map((row) => [row.date, row])),
  });
}

function sumBuckets(
  buckets: Map<string, MetricBucket>,
  startMs: number,
  endMs: number,
  keyFor: (valueMs: number) => string,
  stepMs: number,
): MetricBucket {
  const total = emptyBucket();
  for (let cursor = startMs; cursor <= endMs; cursor += stepMs) {
    const bucket = buckets.get(keyFor(cursor));
    if (!bucket) continue;
    total.costUsd = addUsd(total.costUsd, bucket.costUsd);
    total.durationMs += bucket.durationMs;
  }
  return total;
}

function rangeWindow(
  buckets: Map<string, MetricBucket>,
  nowMs: number,
  range: Range,
  conversations: number,
): ActorWindowMetrics {
  if (range === 1) {
    const current = trailingUtcHourWindow(nowMs, 24);
    const priorEndMs = current.start.getTime() - HOUR_MS;
    const priorStartMs = priorEndMs - 23 * HOUR_MS;
    const currentTotals = sumBuckets(
      buckets,
      current.start.getTime(),
      current.end.getTime(),
      utcHourKey,
      HOUR_MS,
    );
    const priorTotals = sumBuckets(
      buckets,
      priorStartMs,
      priorEndMs,
      utcHourKey,
      HOUR_MS,
    );
    return {
      conversations,
      costUsd: currentTotals.costUsd,
      durationMs: currentTotals.durationMs,
      priorCostUsd: priorTotals.costUsd,
    };
  }

  const current = trailingUtcDayWindow(nowMs, range);
  const priorEndMs = current.start.getTime() - DAY_MS;
  const priorStartMs = priorEndMs - (range - 1) * DAY_MS;
  const currentTotals = sumBuckets(
    buckets,
    current.start.getTime(),
    current.end.getTime(),
    utcDayKey,
    DAY_MS,
  );
  const priorTotals = sumBuckets(
    buckets,
    priorStartMs,
    priorEndMs,
    utcDayKey,
    DAY_MS,
  );
  return {
    conversations,
    costUsd: currentTotals.costUsd,
    durationMs: currentTotals.durationMs,
    priorCostUsd: priorTotals.costUsd,
  };
}

function buildActorWindows(args: {
  conversations: Record<Range, number>;
  dayBuckets: Map<string, MetricBucket>;
  hourBuckets: Map<string, MetricBucket>;
  nowMs: number;
}): ActorDirectoryWindows {
  const { conversations, dayBuckets, hourBuckets, nowMs } = args;
  return {
    1: rangeWindow(hourBuckets, nowMs, 1, conversations[1]),
    7: rangeWindow(dayBuckets, nowMs, 7, conversations[7]),
    30: rangeWindow(dayBuckets, nowMs, 30, conversations[30]),
    90: rangeWindow(dayBuckets, nowMs, 90, conversations[90]),
  };
}

/** Start of the current period of each directory range. */
function rangeStart(nowMs: number, range: Range): Date {
  return range === 1
    ? trailingUtcHourWindow(nowMs, 24).start
    : trailingUtcDayWindow(nowMs, range).start;
}

function metricBuckets(
  rows: {
    costUsd: number | null;
    date: string;
    durationMs: number;
    email: string;
  }[],
): Map<string, Map<string, MetricBucket>> {
  const byEmail = new Map<string, Map<string, MetricBucket>>();
  for (const row of rows) {
    const buckets = byEmail.get(row.email) ?? new Map<string, MetricBucket>();
    byEmail.set(row.email, buckets);
    buckets.set(row.date, {
      costUsd: row.costUsd ?? 0,
      durationMs: row.durationMs,
    });
  }
  return byEmail;
}

/**
 * Load the complete People directory with grouping and metrics owned by SQL.
 *
 * Every count and total comes from Turns. A person counts a Conversation when
 * they ran a Turn in it, whoever started it.
 */
export async function readPeopleListFromSql(): Promise<ActorDirectoryReport> {
  const nowMs = Date.now();
  const { end, start } = trailingUtcDayWindow(nowMs, DIRECTORY_ACTIVITY_DAYS);
  const hourWindow = trailingUtcHourWindow(nowMs, WINDOW_SEVEN_DAY_HOURS);
  const sixHourWindow = trailingUtcSixHourWindow(nowMs);
  const dayMetricStart = trailingUtcDayWindow(nowMs, DAY_METRIC_LOOKBACK).start;
  // Person window metrics still only need prior+current 24h for the 1d range.
  const hourMetricStart = trailingUtcHourWindow(
    nowMs,
    HOUR_METRIC_LOOKBACK,
  ).start;
  const turns = personTurns();
  const { active, conversations, costUsd, durationMs, failed, tokens } =
    turnAggregateColumns(turns);
  const day = turnBucket(turns, "day");
  const hour = turnBucket(turns, "hour");
  const sixHour = sql<string>`TO_CHAR(
    date_trunc('day', ${turns.occurredAt} AT TIME ZONE 'UTC')
      + (FLOOR(EXTRACT(HOUR FROM ${turns.occurredAt} AT TIME ZONE 'UTC') / 6) * INTERVAL '6 hours'),
    'YYYY-MM-DD"T"HH24'
  )`;
  const rangeConversations = (range: Range) =>
    sql<number>`COUNT(DISTINCT ${turns.rootConversationId}) FILTER (
      WHERE ${turns.occurredAt} >= ${rangeStart(nowMs, range).toISOString()}::timestamptz
    )::integer`;
  const spendRows = (since: Date, bucket: typeof day) =>
    getDb()
      .select({ email: turns.email, date: bucket, costUsd, durationMs })
      .from(turns)
      .where(gte(turns.occurredAt, since))
      .groupBy(turns.email, bucket);
  const activityRows = (since: Date, bucket: typeof day) =>
    getDb()
      .select({
        activePeople: sql<number>`COUNT(DISTINCT ${turns.userId})::int`,
        conversations,
        date: bucket,
      })
      .from(turns)
      .where(gte(turns.occurredAt, since))
      .groupBy(bucket);
  const [
    rows,
    activityDayRows,
    activityHourRows,
    activitySixHourRows,
    daySpendRows,
    hourSpendRows,
  ] = await Promise.all([
    getDb()
      .select({
        ...turnPersonColumns(turns),
        active,
        conversations,
        durationMs,
        failed,
        tokens,
        conversations1: rangeConversations(1),
        conversations7: rangeConversations(7),
        conversations30: rangeConversations(30),
        conversations90: rangeConversations(90),
      })
      .from(turns)
      .innerJoin(turnRoot, turnRootJoin(turns))
      .groupBy(turns.email, turns.fullName),
    activityRows(start, day),
    activityRows(hourWindow.start, hour),
    activityRows(sixHourWindow.start, sixHour),
    spendRows(dayMetricStart, day),
    spendRows(hourMetricStart, hour),
  ]);

  const dayBucketsByEmail = metricBuckets(daySpendRows);
  const hourBucketsByEmail = metricBuckets(hourSpendRows);
  const people: ActorSummaryReport[] = rows.map((row) => {
    const actor: ActorIdentity & { email: string } = {
      email: row.email,
      ...(row.fullName ? { fullName: row.fullName } : undefined),
      ...(row.slackUserId ? { slackUserId: row.slackUserId } : undefined),
      ...(row.slackUserName ? { slackUserName: row.slackUserName } : undefined),
    };
    return {
      active: row.active,
      activeDays: row.activeDays,
      conversations: row.conversations,
      durationMs: row.durationMs,
      failed: row.failed,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      actor,
      windows: buildActorWindows({
        conversations: {
          1: row.conversations1,
          7: row.conversations7,
          30: row.conversations30,
          90: row.conversations90,
        },
        dayBuckets:
          dayBucketsByEmail.get(row.email) ?? new Map<string, MetricBucket>(),
        hourBuckets:
          hourBucketsByEmail.get(row.email) ?? new Map<string, MetricBucket>(),
        nowMs,
      }),
      ...(row.tokens !== null ? { tokens: row.tokens } : undefined),
    };
  });

  return {
    activityDays: directoryActivityDays(activityDayRows, nowMs),
    activityHours: directoryActivityHours(activityHourRows, nowMs),
    activitySixHours: directoryActivitySixHours(activitySixHourRows, nowMs),
    generatedAt: new Date(nowMs).toISOString(),
    people: people.sort(
      (left, right) =>
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) ||
        right.conversations - left.conversations ||
        left.actor.email.localeCompare(right.actor.email),
    ),
    source: "conversation_index",
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}
