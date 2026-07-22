import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import type {
  ActorActivityDayReport,
  ConversationStatsItem,
  ActorTotalsReport,
} from "./schema";
import { participantMatchColumn } from "@/chat/conversations/participant";

export const RECENT_LIMIT = 25;
export const ACTIVITY_DAYS = 365;

const privacyRoot = alias(juniorConversations, "people_privacy_root");
const privacyRootIdentity = alias(
  juniorIdentities,
  "people_privacy_root_identity",
);
const privacyRootDestination = alias(
  juniorDestinations,
  "people_privacy_root_destination",
);

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
  const items: ActorActivityDayReport[] = [];
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (ACTIVITY_DAYS - 1));

  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    items.push(days.get(date) ?? emptyActivityDay(date));
  }
  return items;
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
export async function recentActorRows(
  email: string,
  authorizedUserEmail?: string,
) {
  return getDb()
    .select({
      channelName: juniorConversations.channelName,
      conversationId: juniorConversations.conversationId,
      createdAt: juniorConversations.createdAt,
      destinationId: juniorDestinations.id,
      destinationVisibility: privacyRootDestination.visibility,
      durationMs: juniorConversations.durationMs,
      email: juniorUsers.primaryEmailNormalized,
      executionStatus: juniorConversations.executionStatus,
      executionUpdatedAt: juniorConversations.executionUpdatedAt,
      fullName: juniorUsers.displayName,
      handle: juniorIdentities.handle,
      isParticipant: participantMatchColumn(authorizedUserEmail, {
        emailNormalized: privacyRootIdentity.emailNormalized,
        emailVerified: privacyRootIdentity.emailVerified,
      }),
      lastActivityAt: juniorConversations.lastActivityAt,
      providerSubjectId: juniorIdentities.providerSubjectId,
      source: juniorConversations.source,
      title: juniorConversations.title,
      updatedAt: juniorConversations.updatedAt,
      usage: juniorConversations.usage,
    })
    .from(juniorConversations)
    .leftJoin(
      privacyRoot,
      and(
        eq(privacyRoot.conversationId, juniorConversations.rootConversationId),
        eq(privacyRoot.rootConversationId, privacyRoot.conversationId),
        isNull(privacyRoot.parentConversationId),
        or(
          isNotNull(juniorConversations.parentConversationId),
          eq(
            juniorConversations.rootConversationId,
            juniorConversations.conversationId,
          ),
        ),
      ),
    )
    .leftJoin(
      privacyRootIdentity,
      eq(privacyRootIdentity.id, privacyRoot.actorIdentityId),
    )
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .leftJoin(
      privacyRootDestination,
      eq(privacyRootDestination.id, privacyRoot.destinationId),
    )
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(
      and(verifiedActorWhere(email), isNull(juniorConversations.archivedAt)),
    )
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(RECENT_LIMIT);
}
