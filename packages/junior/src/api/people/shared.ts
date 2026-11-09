import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import {
  juniorConversationMetrics,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import type { ConversationMetric } from "@/db/schema/conversation-metrics";
import type {
  ActorActivityDayReport,
  ConversationStatsItem,
  ActorTotalsReport,
} from "../schema/person";
import {
  WINDOW_SEVEN_DAY_HOURS,
  fillUtcDays,
  fillUtcHours,
  sumUtcHoursIntoSixHours,
} from "../reporting-window";

export const RECENT_LIMIT = 25;
export const ACTIVITY_DAYS = 365;

function turnMetricSum(metric: ConversationMetric) {
  return sql`SUM(${juniorConversationMetrics.value}) FILTER (
    WHERE ${juniorConversationMetrics.metric} = ${metric}
  )`;
}

/** Sum the spend of Turn metric rows read straight from their table. */
export const turnMetricColumns = {
  costUsd: sql<number | null>`${turnMetricSum("cost_usd")}::double precision`,
};

/** Root Conversation of a person's Turn, for status, location, and surface. */
export const turnRoot = alias(juniorConversations, "person_turn_root");

/**
 * Read one row per Turn metric of each verified person, with the root
 * Conversation of the Turn.
 *
 * People counts and spend come only from Turns. The Actor that started a
 * Conversation does not matter here.
 */
export function personTurns(email?: string) {
  return getDb()
    .select({
      conversationId:
        sql<string>`${juniorConversationMetrics.conversationId}`.as(
          "turn_conversation_id",
        ),
      email: sql<string>`${juniorUsers.primaryEmailNormalized}`.as("email"),
      fullName: juniorUsers.displayName,
      metric: juniorConversationMetrics.metric,
      occurredAt: juniorConversationMetrics.occurredAt,
      rootConversationId: sql<string>`coalesce(
        ${juniorConversations.rootConversationId},
        ${juniorConversations.conversationId}
      )`.as("turn_root_conversation_id"),
      // Web identities use the email as the subject. Only Slack fills these.
      slackUserId: sql<
        string | null
      >`CASE WHEN ${juniorIdentities.provider} = 'slack' THEN ${juniorIdentities.providerSubjectId} END`.as(
        "slack_user_id",
      ),
      slackUserName: sql<
        string | null
      >`CASE WHEN ${juniorIdentities.provider} = 'slack' THEN ${juniorIdentities.handle} END`.as(
        "slack_user_name",
      ),
      userId: sql<string>`${juniorUsers.id}`.as("user_id"),
      value: juniorConversationMetrics.value,
    })
    .from(juniorConversationMetrics)
    .innerJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorConversationMetrics.conversationId,
      ),
    )
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversationMetrics.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(verifiedActorWhere(email))
    .as("person_turns");
}

/** Rows from {@link personTurns}. */
export type PersonTurns = ReturnType<typeof personTurns>;

/** Join a person's Turn rows to the root Conversation of each Turn. */
export function turnRootJoin(turns: PersonTurns) {
  return eq(turnRoot.conversationId, turns.rootConversationId);
}

function turnSum(turns: PersonTurns, metric: ConversationMetric) {
  return sql`SUM(${turns.value}) FILTER (WHERE ${turns.metric} = ${metric})`;
}

/**
 * Aggregate a person's Turn rows. A Conversation counts once for each person
 * who ran a Turn in it. Child Conversation Turns count for the root.
 */
export function turnAggregateColumns(turns: PersonTurns) {
  const roots = sql`COUNT(DISTINCT ${turns.rootConversationId})`;
  return {
    active: sql<number>`${roots} FILTER (
      WHERE ${turnRoot.executionStatus} NOT IN ('idle', 'failed')
    )::integer`,
    conversations: sql<number>`${roots}::integer`,
    costUsd: sql<
      number | null
    >`${turnSum(turns, "cost_usd")}::double precision`,
    durationMs: sql<number>`COALESCE(${turnSum(turns, "duration_ms")}, 0)::double precision`,
    // A stopped Conversation reports `stopped`, not `failed`.
    failed: sql<number>`${roots} FILTER (
      WHERE ${turnRoot.executionStatus} = 'failed' AND ${turnRoot.stoppedAt} IS NULL
    )::integer`,
    tokens: sql<
      number | null
    >`${turnSum(turns, "total_tokens")}::double precision`,
  };
}

/** Format the UTC day or hour of a person's Turn rows for activity buckets. */
export function turnBucket(turns: PersonTurns, unit: "day" | "hour") {
  const format = unit === "day" ? "YYYY-MM-DD" : 'YYYY-MM-DD"T"HH24';
  return sql<string>`TO_CHAR(${turns.occurredAt} AT TIME ZONE 'UTC', ${sql.raw(`'${format}'`)})`;
}

/** Select the identity fields and Turn range of a grouped person row. */
export function turnPersonColumns(turns: PersonTurns) {
  return {
    activeDays: sql<number>`COUNT(DISTINCT (${turns.occurredAt} AT TIME ZONE 'UTC')::date)::integer`,
    email: turns.email,
    firstSeenAt: sql`MIN(${turns.occurredAt})`.mapWith(
      juniorConversationMetrics.occurredAt,
    ),
    fullName: turns.fullName,
    lastSeenAt: sql`MAX(${turns.occurredAt})`.mapWith(
      juniorConversationMetrics.occurredAt,
    ),
    slackUserId: sql<string | null>`MAX(${turns.slackUserId})`,
    slackUserName: sql<string | null>`MAX(${turns.slackUserName})`,
  };
}

/** Normalize emails before matching people API rows. */
export function normalizeEmail(email: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized || undefined;
}

/** Build a zeroed totals object for people API aggregations. */
export function emptyTotals(): ActorTotalsReport {
  return {
    active: 0,
    activeDays: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
  };
}

/** Build a zeroed activity day for the people profile window. */
export function emptyActivityDay(date: string): ActorActivityDayReport {
  return {
    active: 0,
    conversations: 0,
    date,
    durationMs: 0,
    failed: 0,
  };
}

/** Fill the fixed people profile activity window from sparse day totals. */
export function activityDays(
  days: Map<string, ActorActivityDayReport>,
  nowMs: number,
): ActorActivityDayReport[] {
  return fillUtcDays({
    count: ACTIVITY_DAYS,
    empty: emptyActivityDay,
    nowMs,
    rows: days,
  });
}

/**
 * Fill the trailing 7-day people activity hour window from known hour totals.
 * 24h charts use the last 24 points. 7d charts sum hours into 6-hour buckets.
 */
export function activityHours(
  hours: Map<string, ActorActivityDayReport>,
  nowMs: number,
): ActorActivityDayReport[] {
  return fillUtcHours({
    count: WINDOW_SEVEN_DAY_HOURS,
    empty: emptyActivityDay,
    nowMs,
    rows: hours,
  });
}

/**
 * Fill trailing 6-hour people activity buckets from hour keys or hour rows.
 * Hour keys must be summed into 6-hour keys first.
 */
export function activitySixHours(
  hours:
    | Map<string, ActorActivityDayReport>
    | readonly ActorActivityDayReport[],
  nowMs: number,
): ActorActivityDayReport[] {
  const series =
    hours instanceof Map ? activityHours(hours, nowMs) : [...hours];
  return sumUtcHoursIntoSixHours({
    empty: emptyActivityDay,
    hours: series,
    nowMs,
  });
}

/** Return deterministic stats rows for people API responses. */
export function statsItems(map: Map<string, ConversationStatsItem>) {
  return [...map.values()].sort(
    (left, right) =>
      right.conversations - left.conversations ||
      right.durationMs - left.durationMs ||
      left.label.localeCompare(right.label),
  );
}

/**
 * Build the verified person actor predicate shared by People aggregate and
 * recent-row queries.
 *
 * Any provider counts, so Slack and dashboard (web) Conversations roll up to
 * the same person. System identities never count.
 */
export function verifiedActorWhere(email?: string) {
  const normalizedEmail = normalizeEmail(email);
  return and(
    eq(juniorIdentities.kind, "user"),
    eq(juniorIdentities.emailVerified, true),
    sql`${juniorUsers.primaryEmailNormalized} IS NOT NULL`,
    normalizedEmail
      ? eq(juniorUsers.primaryEmailNormalized, normalizedEmail)
      : undefined,
  );
}

/** Read the recent Conversations where a person ran a Turn. */
export async function recentActorRows(email: string) {
  const turns = personTurns(email);
  return getDb()
    .select({
      channelName: juniorConversations.channelName,
      conversationId: juniorConversations.conversationId,
      createdAt: juniorConversations.createdAt,
      destinationId: juniorDestinations.id,
      durationMs: juniorConversations.durationMs,
      email: juniorUsers.primaryEmailNormalized,
      executionStatus: juniorConversations.executionStatus,
      stoppedAt: juniorConversations.stoppedAt,
      executionUpdatedAt: juniorConversations.executionUpdatedAt,
      fullName: juniorUsers.displayName,
      kind: juniorConversations.kind,
      parentConversationId: juniorConversations.parentConversationId,
      archivedAt: juniorConversations.archivedAt,
      // Web identities use the email as the subject. Only Slack fills these.
      handle: sql<
        string | null
      >`CASE WHEN ${juniorIdentities.provider} = 'slack' THEN ${juniorIdentities.handle} END`,
      lastActivityAt: juniorConversations.lastActivityAt,
      providerSubjectId: sql<
        string | null
      >`CASE WHEN ${juniorIdentities.provider} = 'slack' THEN ${juniorIdentities.providerSubjectId} END`,
      source: juniorConversations.source,
      title: juniorConversations.title,
      updatedAt: juniorConversations.updatedAt,
      usage: juniorConversations.usage,
    })
    .from(juniorConversations)
    .leftJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(
      inArray(
        juniorConversations.conversationId,
        getDb().selectDistinct({ id: turns.conversationId }).from(turns),
      ),
    )
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(RECENT_LIMIT);
}
