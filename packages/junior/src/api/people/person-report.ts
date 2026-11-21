import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { notLeadConversation } from "@/chat/conversations/sql/listed";
import { getDb } from "@/chat/db";
import {
  juniorConversationMetrics,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import {
  conversationIsActiveSql,
  conversationStatusSql,
  conversationTurnFailedSql,
} from "@/chat/conversations/sql/status";
import type { ConversationMetric } from "@/db/schema/conversation-metrics";
import { microUsdSql } from "@/db/micro-usd";
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

const metrics = juniorConversationMetrics;

/** Sum the values of one metric among grouped metric rows. */
export function metricSum(metric: ConversationMetric) {
  return sql`sum(${metrics.value}) FILTER (WHERE ${metrics.metric} = ${metric})`;
}

/** Sum the spend of Turn metric rows read straight from their table. */
export const turnMetricColumns = {
  costMicroUsd: microUsdSql(metricSum("cost_micro_usd")),
};

/** Root Conversation of a person's Turn, for status, location, and surface. */
export const turnRoot = alias(juniorConversations, "person_turn_root");

/** Root of a Conversation row: itself when it has no root. */
export const conversationRootId = sql<string>`coalesce(
  ${juniorConversations.rootConversationId},
  ${juniorConversations.conversationId}
)`;

/**
 * Read one row per verified person and root Conversation where they ran a
 * Turn, over all time: the Turn range and the duration and token totals.
 *
 * The person and metric filters apply to the metric rows, and the rows are
 * grouped before any join. Every Run writes a `duration_ms` row, so these
 * two metrics mark every Turn.
 */
export function personRoots(email?: string) {
  const verifiedIdentities = getDb()
    .select({ id: juniorIdentities.id })
    .from(juniorIdentities)
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(verifiedActorWhere(email));
  // Group the metric rows before any join, so the joins read one row per
  // identity and Conversation.
  const conversations = getDb()
    .select({
      identityId: sql<string>`${metrics.actorIdentityId}`.as(
        "turn_identity_id",
      ),
      conversationId: sql<string>`${metrics.conversationId}`.as(
        "turn_conversation_id",
      ),
      firstAt: sql<Date>`min(${metrics.occurredAt})`.as("turn_first_at"),
      lastAt: sql<Date>`max(${metrics.occurredAt})`.as("turn_last_at"),
      durationMs: metricSum("duration_ms").as("turn_duration_ms"),
      tokens: metricSum("total_tokens").as("turn_tokens"),
    })
    .from(metrics)
    .where(
      and(
        inArray(metrics.actorIdentityId, verifiedIdentities),
        inArray(metrics.metric, ["duration_ms", "total_tokens"]),
      ),
    )
    .groupBy(metrics.actorIdentityId, metrics.conversationId)
    .as("person_conversation_turns");
  return getDb()
    .select({
      userId: sql<string>`${juniorIdentities.userId}`.as("root_user_id"),
      rootConversationId: conversationRootId.as("person_root_id"),
      firstAt: sql<Date>`min(${conversations.firstAt})`.as("root_first_at"),
      lastAt: sql<Date>`max(${conversations.lastAt})`.as("root_last_at"),
      durationMs: sql`sum(${conversations.durationMs})`.as("root_duration_ms"),
      tokens: sql`sum(${conversations.tokens})`.as("root_tokens"),
      // Web identities use the email as the subject. Only Slack fills these.
      slackUserId: sql<
        string | null
      >`max(CASE WHEN ${juniorIdentities.provider} = 'slack' THEN ${juniorIdentities.providerSubjectId} END)`.as(
        "root_slack_user_id",
      ),
      slackUserName: sql<
        string | null
      >`max(CASE WHEN ${juniorIdentities.provider} = 'slack' THEN ${juniorIdentities.handle} END)`.as(
        "root_slack_user_name",
      ),
    })
    .from(conversations)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, conversations.identityId),
    )
    .innerJoin(
      juniorConversations,
      eq(juniorConversations.conversationId, conversations.conversationId),
    )
    .groupBy(juniorIdentities.userId, conversationRootId)
    .as("person_roots");
}

/** Rows from {@link personRoots}. */
export type PersonRoots = ReturnType<typeof personRoots>;

/** Join a person's roots to the root Conversation rows. */
export function personRootJoin(roots: PersonRoots) {
  return eq(turnRoot.conversationId, roots.rootConversationId);
}

/**
 * Aggregate rows from {@link personRoots} joined to {@link turnRoot}. A
 * Conversation counts once for each person who ran a Turn in it, and child
 * Conversation Turns count for the root. Each row is one root of one person,
 * so plain counts need no DISTINCT. Active and failed read the root's current
 * status.
 */
export function rootAggregateColumns(roots: PersonRoots) {
  return {
    active: sql<number>`(count(*) FILTER (WHERE ${conversationIsActiveSql(turnRoot)}))::integer`,
    conversations: sql<number>`count(*)::integer`,
    durationMs: sql<number>`COALESCE(sum(${roots.durationMs}), 0)::double precision`,
    failed: sql<number>`(count(*) FILTER (WHERE ${conversationTurnFailedSql(turnRoot)} AND ${turnRoot.stoppedAt} IS NULL))::integer`,
    tokens: sql<number | null>`sum(${roots.tokens})::double precision`,
  };
}

/**
 * Count the UTC days on which the grouped person ran a Turn. A correlated
 * subquery runs once per person through the actor index, so a bad row
 * estimate cannot make Postgres repeat it once per root.
 */
function personActiveDays() {
  // Any metric row marks a Turn, so the actor index alone answers this.
  const days = getDb()
    .selectDistinct({
      day: sql`(${metrics.occurredAt} AT TIME ZONE 'UTC')::date`.as("turn_day"),
    })
    .from(metrics)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, metrics.actorIdentityId),
    )
    .where(
      and(
        eq(juniorIdentities.userId, juniorUsers.id),
        eq(juniorIdentities.kind, "user"),
        eq(juniorIdentities.emailVerified, true),
      ),
    )
    .as("person_turn_days");
  return sql<number>`(${getDb()
    .select({ days: sql`count(*)` })
    .from(days)})::integer`;
}

/**
 * Select the identity, Turn range, and totals of one person from roots
 * grouped by person and joined to {@link juniorUsers}.
 */
export function personTotalColumns(roots: PersonRoots) {
  return {
    ...rootAggregateColumns(roots),
    activeDays: personActiveDays(),
    email: sql<string>`${juniorUsers.primaryEmailNormalized}`,
    firstSeenAt: sql`min(${roots.firstAt})`.mapWith(metrics.occurredAt),
    fullName: juniorUsers.displayName,
    lastSeenAt: sql`max(${roots.lastAt})`.mapWith(metrics.occurredAt),
    slackUserId: sql<string | null>`max(${roots.slackUserId})`,
    slackUserName: sql<string | null>`max(${roots.slackUserName})`,
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

/** Read the Conversations where a person ran a Turn, by their last Turn. */
export async function recentActorRows(email: string) {
  // Every Run writes one `duration_ms` row.
  const lastTurns = getDb()
    .select({
      conversationId: sql<string>`${metrics.conversationId}`.as(
        "turn_conversation_id",
      ),
      lastTurnAt: sql`max(${metrics.occurredAt})`.as("last_turn_at"),
    })
    .from(metrics)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, metrics.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(and(verifiedActorWhere(email), eq(metrics.metric, "duration_ms")))
    .groupBy(metrics.conversationId)
    .as("person_last_turns");
  return getDb()
    .select({
      channelName: juniorConversations.channelName,
      conversationId: juniorConversations.conversationId,
      createdAt: juniorConversations.createdAt,
      destinationId: juniorDestinations.id,
      durationMs: juniorConversations.durationMs,
      email: juniorUsers.primaryEmailNormalized,
      executionStatus: juniorConversations.executionStatus,
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
      status: conversationStatusSql(juniorConversations),
      title: juniorConversations.title,
      updatedAt: juniorConversations.updatedAt,
      usage: juniorConversations.usage,
    })
    .from(lastTurns)
    .innerJoin(
      juniorConversations,
      eq(juniorConversations.conversationId, lastTurns.conversationId),
    )
    .leftJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(notLeadConversation())
    .orderBy(
      desc(lastTurns.lastTurnAt),
      asc(juniorConversations.conversationId),
    )
    .limit(RECENT_LIMIT);
}
