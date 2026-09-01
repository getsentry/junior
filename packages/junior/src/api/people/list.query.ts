import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import {
  conversationActiveDaysColumn,
  conversationRangeColumns,
} from "../conversations/aggregate";
import type {
  ActorDirectoryRange,
  ActorDirectoryReport,
  ActorDirectoryWindows,
  ActorIdentity,
  ActorSummaryReport,
  ActorWindowMetrics,
  PeopleActivityDayReport,
} from "../schema/person";
import {
  peopleTreeAggregateColumns,
  peopleTreeConversation,
  peopleTreeMetricsJoin,
  verifiedActorWhere,
} from "./shared";
import {
  DAY_MS,
  HOUR_MS,
  fillUtcDays,
  fillUtcHours,
  trailingUtcDayWindow,
  trailingUtcHourWindow,
  utcDayKey,
  utcHourKey,
} from "../reporting-window";

const DIRECTORY_ACTIVITY_DAYS = 90;
const DIRECTORY_RANGES = [1, 7, 30, 90] as const satisfies readonly ActorDirectoryRange[];
const DAY_METRIC_LOOKBACK = 180;
const HOUR_METRIC_LOOKBACK = 48;

type MetricBucket = {
  conversations: number;
  costUsd: number;
  durationMs: number;
};

function activityWindow(nowMs: number) {
  return trailingUtcDayWindow(nowMs, DIRECTORY_ACTIVITY_DAYS);
}

function emptyDirectoryDay(date: string): PeopleActivityDayReport {
  return { activePeople: 0, conversations: 0, date };
}

function emptyWindowMetrics(): ActorWindowMetrics {
  return {
    conversations: 0,
    costUsd: 0,
    durationMs: 0,
    priorCostUsd: 0,
  };
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
    empty: emptyDirectoryDay,
    nowMs,
    rows: new Map(rows.map((row) => [row.date, row])),
  });
}

function dayMetricLookbackStart(nowMs: number): Date {
  const { start } = trailingUtcDayWindow(nowMs, DAY_METRIC_LOOKBACK);
  return start;
}

function hourMetricLookbackStart(nowMs: number): Date {
  const { start } = trailingUtcHourWindow(nowMs, HOUR_METRIC_LOOKBACK);
  return start;
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

function buildActorWindows(args: {
  dayBuckets: Map<string, MetricBucket>;
  hourBuckets: Map<string, MetricBucket>;
  nowMs: number;
}): ActorDirectoryWindows {
  const windows = {
    1: emptyWindowMetrics(),
    7: emptyWindowMetrics(),
    30: emptyWindowMetrics(),
    90: emptyWindowMetrics(),
  } satisfies ActorDirectoryWindows;

  for (const range of DIRECTORY_RANGES) {
    if (range === 1) {
      const current = trailingUtcHourWindow(args.nowMs, 24);
      const priorEndMs = current.start.getTime() - HOUR_MS;
      const priorStartMs = priorEndMs - 23 * HOUR_MS;
      const currentTotals = sumBuckets(
        args.hourBuckets,
        current.start.getTime(),
        current.end.getTime(),
        utcHourKey,
        HOUR_MS,
      );
      const priorTotals = sumBuckets(
        args.hourBuckets,
        priorStartMs,
        priorEndMs,
        utcHourKey,
        HOUR_MS,
      );
      windows[1] = {
        conversations: currentTotals.conversations,
        costUsd: currentTotals.costUsd,
        durationMs: currentTotals.durationMs,
        priorCostUsd: priorTotals.costUsd,
      };
      continue;
    }

    const current = trailingUtcDayWindow(args.nowMs, range);
    const priorEndMs = current.start.getTime() - DAY_MS;
    const priorStartMs = priorEndMs - (range - 1) * DAY_MS;
    const currentTotals = sumBuckets(
      args.dayBuckets,
      current.start.getTime(),
      current.end.getTime(),
      utcDayKey,
      DAY_MS,
    );
    const priorTotals = sumBuckets(
      args.dayBuckets,
      priorStartMs,
      priorEndMs,
      utcDayKey,
      DAY_MS,
    );
    windows[range] = {
      conversations: currentTotals.conversations,
      costUsd: currentTotals.costUsd,
      durationMs: currentTotals.durationMs,
      priorCostUsd: priorTotals.costUsd,
    };
  }

  return windows;
}

/** Load the complete People directory with grouping and metrics owned by SQL. */
export async function readPeopleListFromSql(): Promise<ActorDirectoryReport> {
  const nowMs = Date.now();
  const { end, start } = activityWindow(nowMs);
  const activityDate = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  const activityHour = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24'
  )`;
  const hourWindow = trailingUtcHourWindow(nowMs);
  const dayMetricStart = dayMetricLookbackStart(nowMs);
  const hourMetricStart = hourMetricLookbackStart(nowMs);
  const metricsJoin = peopleTreeMetricsJoin();
  const [
    rows,
    activityRows,
    activityHourRows,
    dayMetricRows,
    hourMetricRows,
  ] = await Promise.all([
    getDb()
      .select({
        email: juniorUsers.primaryEmailNormalized,
        fullName: juniorUsers.displayName,
        slackUserId: sql<
          string | null
        >`MAX(${juniorIdentities.providerSubjectId})`,
        slackUserName: sql<string | null>`MAX(${juniorIdentities.handle})`,
        activeDays: conversationActiveDaysColumn(),
        ...peopleTreeAggregateColumns,
        ...conversationRangeColumns(),
      })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .leftJoin(peopleTreeConversation, metricsJoin)
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
        email: juniorUsers.primaryEmailNormalized,
        date: activityDate,
        conversations: peopleTreeAggregateColumns.conversations,
        costUsd: peopleTreeAggregateColumns.costUsd,
        durationMs: peopleTreeAggregateColumns.durationMs,
      })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .leftJoin(peopleTreeConversation, metricsJoin)
      .where(
        and(
          verifiedActorWhere(),
          gte(juniorConversations.lastActivityAt, dayMetricStart),
        ),
      )
      .groupBy(
        juniorUsers.primaryEmailNormalized,
        activityDate,
      ),
    getDb()
      .select({
        email: juniorUsers.primaryEmailNormalized,
        date: activityHour,
        conversations: peopleTreeAggregateColumns.conversations,
        costUsd: peopleTreeAggregateColumns.costUsd,
        durationMs: peopleTreeAggregateColumns.durationMs,
      })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .leftJoin(peopleTreeConversation, metricsJoin)
      .where(
        and(
          verifiedActorWhere(),
          gte(juniorConversations.lastActivityAt, hourMetricStart),
        ),
      )
      .groupBy(
        juniorUsers.primaryEmailNormalized,
        activityHour,
      ),
  ]);

  const dayBucketsByEmail = new Map<string, Map<string, MetricBucket>>();
  for (const row of dayMetricRows) {
    const buckets =
      dayBucketsByEmail.get(row.email) ?? new Map<string, MetricBucket>();
    buckets.set(row.date, {
      conversations: row.conversations,
      costUsd: row.costUsd ?? 0,
      durationMs: row.durationMs,
    });
    dayBucketsByEmail.set(row.email, buckets);
  }

  const hourBucketsByEmail = new Map<string, Map<string, MetricBucket>>();
  for (const row of hourMetricRows) {
    const buckets =
      hourBucketsByEmail.get(row.email) ?? new Map<string, MetricBucket>();
    buckets.set(row.date, {
      conversations: row.conversations,
      costUsd: row.costUsd ?? 0,
      durationMs: row.durationMs,
    });
    hourBucketsByEmail.set(row.email, buckets);
  }

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
        dayBuckets: dayBucketsByEmail.get(row.email) ?? new Map(),
        hourBuckets: hourBucketsByEmail.get(row.email) ?? new Map(),
        nowMs,
      }),
      ...(row.tokens !== null ? { tokens: row.tokens } : undefined),
    };
  });

  return {
    activityDays: directoryActivityDays(activityRows, nowMs),
    activityHours: directoryActivityHours(activityHourRows, nowMs),
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
