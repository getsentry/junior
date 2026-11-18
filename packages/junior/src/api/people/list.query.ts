import { and, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { microUsdSql, microUsdToUsd } from "@/db/micro-usd";
import {
  juniorConversationMetrics,
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import type {
  ActorDirectoryReport,
  ActorIdentity,
  ActorSummaryReport,
  ActorWindowMetrics,
  PeopleActivityDayReport,
} from "../schema/person";
import {
  conversationRootId,
  personRootJoin,
  personRoots,
  personTotalColumns,
  turnRoot,
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
} from "../reporting-window";

const DIRECTORY_ACTIVITY_DAYS = 90;
/** Day ranges need the prior equal period too (90d + prior 90d). */
const DAY_METRIC_LOOKBACK = 180;

type Range = 1 | 7 | 30 | 90;

const metrics = juniorConversationMetrics;

function emptyDirectoryDay(date: string): PeopleActivityDayReport {
  return { activePeople: 0, conversations: 0, date };
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

/** Start of the current period of each directory range. */
function rangeStart(nowMs: number, range: Range): Date {
  return range === 1
    ? trailingUtcHourWindow(nowMs, 24).start
    : trailingUtcDayWindow(nowMs, range).start;
}

/**
 * Sum one range of a person's spend: the current period, and the prior
 * period of equal length that ends where the current one starts.
 */
function rangeSpendColumns(nowMs: number, range: Range) {
  const start = rangeStart(nowMs, range);
  const priorStart = new Date(
    start.getTime() - (range === 1 ? 24 * HOUR_MS : range * DAY_MS),
  );
  const current = sql`${metrics.occurredAt} >= ${start.toISOString()}::timestamptz`;
  const prior = sql`${metrics.occurredAt} >= ${priorStart.toISOString()}::timestamptz
    AND ${metrics.occurredAt} < ${start.toISOString()}::timestamptz`;
  const sum = (metric: "cost_micro_usd" | "duration_ms", when: SQL) =>
    sql`sum(${metrics.value}) FILTER (WHERE ${metrics.metric} = ${metric} AND ${when})`;
  return {
    costMicroUsd: microUsdSql(sum("cost_micro_usd", current)),
    durationMs: sql<number>`COALESCE(${sum("duration_ms", current)}, 0)::double precision`,
    priorCostMicroUsd: microUsdSql(sum("cost_micro_usd", prior)),
  };
}

type RangeSpend = {
  costMicroUsd: number | null;
  durationMs: number;
  priorCostMicroUsd: number | null;
};

function rangeWindow(
  spend: RangeSpend | undefined,
  conversations: number,
): ActorWindowMetrics {
  return {
    conversations,
    costUsd: microUsdToUsd(spend?.costMicroUsd ?? 0),
    durationMs: spend?.durationMs ?? 0,
    priorCostUsd: microUsdToUsd(spend?.priorCostMicroUsd ?? 0),
  };
}

/**
 * Count active people and root Conversations in each bucket from one row per
 * Turn. The time bound applies to the metric rows before any join.
 */
function activityRows(since: Date, unit: "day" | "hour" | "six_hour") {
  const utc = sql`(${metrics.occurredAt} AT TIME ZONE 'UTC')`;
  const bucket =
    unit === "six_hour"
      ? sql<Date>`date_trunc('day', ${utc}) + FLOOR(EXTRACT(HOUR FROM ${utc}) / 6) * INTERVAL '6 hours'`
      : sql<Date>`date_trunc(${sql.raw(`'${unit}'`)}, ${utc})`;
  const format = unit === "day" ? "YYYY-MM-DD" : 'YYYY-MM-DD"T"HH24';
  // One row per bucket, person, and root, so the outer counts stay small.
  const turns = getDb()
    .select({
      bucket: bucket.as("activity_bucket"),
      userId: sql<string>`${juniorUsers.id}`.as("activity_user_id"),
      rootConversationId: conversationRootId.as("activity_root_id"),
    })
    .from(metrics)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, metrics.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .innerJoin(
      juniorConversations,
      eq(juniorConversations.conversationId, metrics.conversationId),
    )
    .where(
      and(
        verifiedActorWhere(),
        // Every Run writes one `duration_ms` row.
        eq(metrics.metric, "duration_ms"),
        gte(metrics.occurredAt, since),
      ),
    )
    .groupBy(bucket, juniorUsers.id, conversationRootId)
    .as("activity_turns");
  return getDb()
    .select({
      activePeople: sql<number>`COUNT(DISTINCT ${turns.userId})::int`,
      conversations: sql<number>`COUNT(DISTINCT ${turns.rootConversationId})::int`,
      date: sql<string>`TO_CHAR(${turns.bucket}, ${sql.raw(`'${format}'`)})`,
    })
    .from(turns)
    .groupBy(turns.bucket);
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
  const roots = personRoots();
  const rangeConversations = (range: Range) =>
    sql<number>`(count(*) FILTER (
      WHERE ${roots.lastAt} >= ${rangeStart(nowMs, range).toISOString()}::timestamptz
    ))::integer`;
  const [rows, activityDayRows, activityHourRows, activitySixHourRows, spend] =
    await Promise.all([
      getDb()
        .select({
          ...personTotalColumns(roots),
          conversations1: rangeConversations(1),
          conversations7: rangeConversations(7),
          conversations30: rangeConversations(30),
          conversations90: rangeConversations(90),
        })
        .from(roots)
        .innerJoin(juniorUsers, eq(juniorUsers.id, roots.userId))
        .innerJoin(turnRoot, personRootJoin(roots))
        .groupBy(juniorUsers.id),
      activityRows(start, "day"),
      activityRows(hourWindow.start, "hour"),
      activityRows(sixHourWindow.start, "six_hour"),
      getDb()
        .select({
          email: sql<string>`${juniorUsers.primaryEmailNormalized}`,
          1: rangeSpendColumns(nowMs, 1),
          7: rangeSpendColumns(nowMs, 7),
          30: rangeSpendColumns(nowMs, 30),
          90: rangeSpendColumns(nowMs, 90),
        })
        .from(metrics)
        .innerJoin(
          juniorIdentities,
          eq(juniorIdentities.id, metrics.actorIdentityId),
        )
        .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
        .where(
          and(
            verifiedActorWhere(),
            inArray(metrics.metric, ["cost_micro_usd", "duration_ms"]),
            gte(
              metrics.occurredAt,
              trailingUtcDayWindow(nowMs, DAY_METRIC_LOOKBACK).start,
            ),
          ),
        )
        .groupBy(juniorUsers.id),
    ]);

  const spendByEmail = new Map(spend.map((row) => [row.email, row]));
  const people: ActorSummaryReport[] = rows.map((row) => {
    const actor: ActorIdentity & { email: string } = {
      email: row.email,
      ...(row.fullName ? { fullName: row.fullName } : undefined),
      ...(row.slackUserId ? { slackUserId: row.slackUserId } : undefined),
      ...(row.slackUserName ? { slackUserName: row.slackUserName } : undefined),
    };
    const personSpend = spendByEmail.get(row.email);
    return {
      active: row.active,
      activeDays: row.activeDays,
      conversations: row.conversations,
      durationMs: row.durationMs,
      failed: row.failed,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      actor,
      windows: {
        1: rangeWindow(personSpend?.[1], row.conversations1),
        7: rangeWindow(personSpend?.[7], row.conversations7),
        30: rangeWindow(personSpend?.[30], row.conversations30),
        90: rangeWindow(personSpend?.[90], row.conversations90),
      },
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
