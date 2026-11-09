import { and, asc, desc, eq, sql } from "drizzle-orm";
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

/** Root Conversation of a Turn metric row, for its location and surface. */
export const turnMetricRoot = alias(juniorConversations, "turn_metric_root");

function turnMetricSum(metric: ConversationMetric) {
  return sql`SUM(${juniorConversationMetrics.value}) FILTER (
    WHERE ${juniorConversationMetrics.metric} = ${metric}
  )`;
}

/**
 * Sum the Turn metric rows of a person. Spend belongs to the Actor of each
 * Turn, not to the Actor that started the Conversation.
 */
export const turnMetricColumns = {
  costUsd: sql<number | null>`${turnMetricSum("cost_usd")}::double precision`,
  durationMs: sql<number>`COALESCE(${turnMetricSum("duration_ms")}, 0)::double precision`,
  tokens: sql<
    number | null
  >`${turnMetricSum("total_tokens")}::double precision`,
};

/** Join each Turn metric row to its Conversation and that Conversation's root. */
export function turnMetricRootJoin() {
  return sql`${turnMetricRoot.conversationId} = (
    SELECT coalesce(${juniorConversations.rootConversationId}, ${juniorConversations.conversationId})
    FROM ${juniorConversations}
    WHERE ${juniorConversations.conversationId} = ${juniorConversationMetrics.conversationId}
  )`;
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

/**
 * Read the Slack user fields for a grouped person row.
 *
 * Web identities use the email as the provider subject, so only Slack
 * identities can supply these fields.
 */
export function slackActorColumns() {
  return {
    slackUserId: sql<
      string | null
    >`MAX(CASE WHEN ${juniorIdentities.provider} = 'slack' THEN ${juniorIdentities.providerSubjectId} END)`,
    slackUserName: sql<
      string | null
    >`MAX(CASE WHEN ${juniorIdentities.provider} = 'slack' THEN ${juniorIdentities.handle} END)`,
  };
}

/** Read only the recent conversation rows required by a People profile. */
export async function recentActorRows(email: string) {
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
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(verifiedActorWhere(email))
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(RECENT_LIMIT);
}
