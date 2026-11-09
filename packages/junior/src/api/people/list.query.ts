import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  juniorConversationMetrics,
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import {
  conversationActiveDaysColumn,
  conversationAggregateColumns,
  conversationRangeColumns,
} from "../conversations/aggregate";
import type {
  ActorDirectoryReport,
  ActorDirectoryWindows,
  ActorIdentity,
  ActorSummaryReport,
  ActorWindowMetrics,
  PeopleActivityDayReport,
} from "../schema/person";
import {
  slackActorColumns,
  turnMetricColumns,
  verifiedActorWhere,
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
  conversations: number;
  costUsd: number;
  durationMs: number;
};

function emptyDirectoryDay(date: string): PeopleActivityDayReport {
  return { activePeople: 0, conversations: 0, date };
}

function emptyBucket(): MetricBucket {
  return { conversations: 0, costUsd: 0, durationMs: 0 };
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
    total.conversations += bucket.conversations;
    total.costUsd = addUsd(total.costUsd, bucket.costUsd);
    total.durationMs += bucket.durationMs;
  }
  return total;
}

function rangeWindow(
  buckets: Map<string, MetricBucket>,
  nowMs: number,
  range: (typeof DIRECTORY_RANGES)[number],
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
      conversations: currentTotals.conversations,
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
    conversations: currentTotals.conversations,
    costUsd: currentTotals.costUsd,
    durationMs: currentTotals.durationMs,
    priorCostUsd: priorTotals.costUsd,
  };
}

function buildActorWindows(args: {
  dayBuckets: Map<string, MetricBucket>;
  hourBuckets: Map<string, MetricBucket>;
  nowMs: number;
}): ActorDirectoryWindows {
  return {
    1: rangeWindow(args.hourBuckets, args.nowMs, 1),
    7: rangeWindow(args.dayBuckets, args.nowMs, 7),
    30: rangeWindow(args.dayBuckets, args.nowMs, 30),
    90: rangeWindow(args.dayBuckets, args.nowMs, 90),
  };
}

function metricBuckets(
  startedRows: { conversations: number; date: string; email: string }[],
  turnRows: {
    costUsd: number | null;
    date: string;
    durationMs: number;
    email: string;
  }[],
): Map<string, Map<string, MetricBucket>> {
  const byEmail = new Map<string, Map<string, MetricBucket>>();
  const bucket = (email: string, date: string) => {
    const buckets = byEmail.get(email) ?? new Map<string, MetricBucket>();
    byEmail.set(email, buckets);
    const current = buckets.get(date) ?? emptyBucket();
    buckets.set(date, current);
    return current;
  };
  for (const row of startedRows) {
    bucket(row.email, row.date).conversations = row.conversations;
  }
  for (const row of turnRows) {
    const current = bucket(row.email, row.date);
    current.costUsd = row.costUsd ?? 0;
    current.durationMs = row.durationMs;
  }
  return byEmail;
}

/** Load the complete People directory with grouping and metrics owned by SQL. */
export async function readPeopleListFromSql(): Promise<ActorDirectoryReport> {
  const nowMs = Date.now();
  const { end, start } = trailingUtcDayWindow(nowMs, DIRECTORY_ACTIVITY_DAYS);
  const activityDate = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  const activityHour = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24'
  )`;
  const hourWindow = trailingUtcHourWindow(nowMs, WINDOW_SEVEN_DAY_HOURS);
  const sixHourWindow = trailingUtcSixHourWindow(nowMs);
  const dayMetricStart = trailingUtcDayWindow(nowMs, DAY_METRIC_LOOKBACK).start;
  // Person window metrics still only need prior+current 24h for the 1d range.
  const hourMetricStart = trailingUtcHourWindow(
    nowMs,
    HOUR_METRIC_LOOKBACK,
  ).start;
  const activitySixHour = sql<string>`TO_CHAR(
    date_trunc('day', ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC')
      + (FLOOR(EXTRACT(HOUR FROM ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC') / 6) * INTERVAL '6 hours'),
    'YYYY-MM-DD"T"HH24'
  )`;
  const metricDate = sql<string>`TO_CHAR(
    ${juniorConversationMetrics.occurredAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  const metricHour = sql<string>`TO_CHAR(
    ${juniorConversationMetrics.occurredAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24'
  )`;
  const { active, conversations, failed } = conversationAggregateColumns();
  // Conversation counts belong to the Actor that started each Conversation.
  // Spend and duration belong to the Actor of each Turn.
  const startedRows = (start: Date, bucket: typeof activityDate) =>
    getDb()
      .select({
        email: juniorUsers.primaryEmailNormalized,
        date: bucket,
        conversations,
      })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(
        and(
          verifiedActorWhere(),
          gte(juniorConversations.lastActivityAt, start),
        ),
      )
      .groupBy(juniorUsers.primaryEmailNormalized, bucket);
  const turnRows = (start: Date, bucket: typeof metricDate) =>
    getDb()
      .select({
        email: juniorUsers.primaryEmailNormalized,
        date: bucket,
        costUsd: turnMetricColumns.costUsd,
        durationMs: turnMetricColumns.durationMs,
      })
      .from(juniorConversationMetrics)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversationMetrics.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(
        and(
          verifiedActorWhere(),
          gte(juniorConversationMetrics.occurredAt, start),
        ),
      )
      .groupBy(juniorUsers.primaryEmailNormalized, bucket);
  const [
    rows,
    turnTotalRows,
    activityRows,
    activityHourRows,
    activitySixHourRows,
    dayStartedRows,
    hourStartedRows,
    dayTurnRows,
    hourTurnRows,
  ] = await Promise.all([
    getDb()
      .select({
        email: juniorUsers.primaryEmailNormalized,
        fullName: juniorUsers.displayName,
        ...slackActorColumns(),
        activeDays: conversationActiveDaysColumn(),
        active,
        conversations,
        failed,
        ...conversationRangeColumns(),
      })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(verifiedActorWhere())
      .groupBy(juniorUsers.primaryEmailNormalized, juniorUsers.displayName),
    getDb()
      .select({
        email: juniorUsers.primaryEmailNormalized,
        fullName: juniorUsers.displayName,
        ...slackActorColumns(),
        durationMs: turnMetricColumns.durationMs,
        tokens: turnMetricColumns.tokens,
        firstSeenAt: sql`MIN(${juniorConversationMetrics.occurredAt})`.mapWith(
          juniorConversationMetrics.occurredAt,
        ),
        lastSeenAt: sql`MAX(${juniorConversationMetrics.occurredAt})`.mapWith(
          juniorConversationMetrics.occurredAt,
        ),
      })
      .from(juniorConversationMetrics)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversationMetrics.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(verifiedActorWhere())
      .groupBy(juniorUsers.primaryEmailNormalized, juniorUsers.displayName),
    getDb()
      .select({
        activePeople: sql<number>`COUNT(DISTINCT ${juniorUsers.id})::int`,
        conversations: sql<number>`COUNT(*)::int`,
        date: activityDate,
      })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(
        and(
          verifiedActorWhere(),
          gte(juniorConversations.lastActivityAt, start),
        ),
      )
      .groupBy(activityDate),
    getDb()
      .select({
        activePeople: sql<number>`COUNT(DISTINCT ${juniorUsers.id})::int`,
        conversations: sql<number>`COUNT(*)::int`,
        date: activityHour,
      })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(
        and(
          verifiedActorWhere(),
          gte(juniorConversations.lastActivityAt, hourWindow.start),
        ),
      )
      .groupBy(activityHour),
    getDb()
      .select({
        activePeople: sql<number>`COUNT(DISTINCT ${juniorUsers.id})::int`,
        conversations: sql<number>`COUNT(*)::int`,
        date: activitySixHour,
      })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(
        and(
          verifiedActorWhere(),
          gte(juniorConversations.lastActivityAt, sixHourWindow.start),
        ),
      )
      .groupBy(activitySixHour),
    startedRows(dayMetricStart, activityDate),
    startedRows(hourMetricStart, activityHour),
    turnRows(dayMetricStart, metricDate),
    turnRows(hourMetricStart, metricHour),
  ]);

  const dayBucketsByEmail = metricBuckets(dayStartedRows, dayTurnRows);
  const hourBucketsByEmail = metricBuckets(hourStartedRows, hourTurnRows);
  const turnTotalsByEmail = new Map(
    turnTotalRows.map((row) => [row.email, row]),
  );
  const startedEmails = new Set(rows.map((row) => row.email));
  // A person who only ran Turns in other people's Conversations still counts.
  const turnOnlyRows = turnTotalRows
    .filter((row) => !startedEmails.has(row.email))
    .map((row) => ({
      ...row,
      active: 0,
      activeDays: 0,
      conversations: 0,
      failed: 0,
    }));

  const people: ActorSummaryReport[] = [...rows, ...turnOnlyRows].map((row) => {
    const turnTotals = turnTotalsByEmail.get(row.email);
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
      durationMs: turnTotals?.durationMs ?? 0,
      failed: row.failed,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      actor,
      windows: buildActorWindows({
        dayBuckets: dayBucketsByEmail.get(row.email) ?? new Map(),
        hourBuckets: hourBucketsByEmail.get(row.email) ?? new Map(),
        nowMs,
      }),
      ...(turnTotals && turnTotals.tokens !== null
        ? { tokens: turnTotals.tokens }
        : undefined),
    };
  });

  return {
    activityDays: directoryActivityDays(activityRows, nowMs),
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
