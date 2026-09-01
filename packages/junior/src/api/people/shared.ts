import { and, asc, desc, eq, isNull, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { conversationAggregateColumns } from "../conversations/aggregate";
import type {
  ActorActivityDayReport,
  ConversationStatsItem,
  ActorTotalsReport,
} from "../schema/person";
import {
  WINDOW_SEVEN_DAY_HOURS,
  fillUtcDays,
  fillUtcHours,
  rollupUtcHoursToSixHours,
} from "../reporting-window";

export const RECENT_LIMIT = 25;
export const ACTIVITY_DAYS = 365;

export const peopleTreeConversation = alias(
  juniorConversations,
  "people_tree_conversation",
);
const peopleRootConversation = alias(
  juniorConversations,
  "people_root_conversation",
);
const peopleRootIdentity = alias(juniorIdentities, "people_root_identity");

export const peopleTreeAggregateColumns = conversationAggregateColumns({
  metrics: peopleTreeConversation,
  roots: juniorConversations,
});

/**
 * Roll metrics through roots without counting a same-actor child twice.
 *
 * A child contributes its own metrics only when its owning root belongs to a
 * different actor.
 */
export function peopleTreeMetricsJoin() {
  const rootOwnedByActor = getDb()
    .select({ conversationId: peopleRootConversation.conversationId })
    .from(peopleRootConversation)
    .innerJoin(
      peopleRootIdentity,
      eq(peopleRootIdentity.id, peopleRootConversation.actorIdentityId),
    )
    .where(
      and(
        eq(
          peopleRootConversation.conversationId,
          juniorConversations.rootConversationId,
        ),
        isNull(peopleRootConversation.parentConversationId),
        eq(
          peopleRootConversation.rootConversationId,
          peopleRootConversation.conversationId,
        ),
        eq(
          peopleRootIdentity.emailNormalized,
          juniorUsers.primaryEmailNormalized,
        ),
        eq(peopleRootIdentity.emailVerified, true),
      ),
    );

  return and(
    eq(
      peopleTreeConversation.rootConversationId,
      juniorConversations.rootConversationId,
    ),
    or(
      eq(
        juniorConversations.rootConversationId,
        juniorConversations.conversationId,
      ),
      and(
        eq(
          peopleTreeConversation.conversationId,
          juniorConversations.conversationId,
        ),
        notExists(rootOwnedByActor),
      ),
    ),
  );
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
 * Fill the trailing 7-day people activity hour window from sparse hour totals.
 * 24h charts slice the trailing 24; 7d charts roll into 6h buckets.
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
 * Fill trailing 6-hour people activity buckets from hour-keyed maps or dense hours.
 * Hour keys must roll up; do not look them up as 6h keys.
 */
export function activitySixHours(
  hours: Map<string, ActorActivityDayReport> | readonly ActorActivityDayReport[],
  nowMs: number,
): ActorActivityDayReport[] {
  const series =
    hours instanceof Map ? activityHours(hours, nowMs) : [...hours];
  return rollupUtcHoursToSixHours({
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

/** Build the verified Slack actor predicate shared by People aggregate and recent-row queries. */
export function verifiedActorWhere(email?: string) {
  const normalizedEmail = normalizeEmail(email);
  return and(
    eq(juniorIdentities.provider, "slack"),
    eq(juniorIdentities.emailVerified, true),
    sql`${juniorUsers.primaryEmailNormalized} IS NOT NULL`,
    normalizedEmail
      ? eq(juniorUsers.primaryEmailNormalized, normalizedEmail)
      : undefined,
  );
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
      executionUpdatedAt: juniorConversations.executionUpdatedAt,
      fullName: juniorUsers.displayName,
      handle: juniorIdentities.handle,
      lastActivityAt: juniorConversations.lastActivityAt,
      providerSubjectId: juniorIdentities.providerSubjectId,
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
