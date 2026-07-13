import { and, asc, desc, eq, sql } from "drizzle-orm";
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
  ActorIdentity,
  ActorTotalsReport,
} from "./schema";
import { conversationSignals } from "../conversations/reporting";

export const SAMPLE_LIMIT = 5_000;
export const RECENT_LIMIT = 25;
export const ACTIVITY_DAYS = 366;

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

/** Build a zeroed labeled stats row for people API aggregations. */
export function emptyStatsItem(label: string): ConversationStatsItem {
  return {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    label,
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

/** Add status counters into a people API aggregate row. */
export function addSignals(
  target: Pick<ActorTotalsReport, "active" | "failed">,
  value: ReturnType<typeof conversationSignals>,
): void {
  target.active += value.active ? 1 : 0;
  target.failed += value.failed ? 1 : 0;
}

/** Return only actor identities that can be grouped by normalized email. */
export function identityWithEmail(
  actor: ActorIdentity | undefined,
): (ActorIdentity & { email: string }) | undefined {
  const email = normalizeEmail(actor?.email);
  if (!email) return undefined;
  return {
    email,
    ...(actor?.fullName ? { fullName: actor.fullName } : {}),
    ...(actor?.slackUserId ? { slackUserId: actor.slackUserId } : {}),
    ...(actor?.slackUserName ? { slackUserName: actor.slackUserName } : {}),
  };
}

/** Preserve the first observed person fields while filling missing details. */
export function mergeIdentity(
  current: ActorIdentity & { email: string },
  next: ActorIdentity & { email: string },
): ActorIdentity & { email: string } {
  return {
    email: current.email,
    ...((current.fullName ?? next.fullName)
      ? { fullName: current.fullName ?? next.fullName }
      : {}),
    ...((current.slackUserId ?? next.slackUserId)
      ? { slackUserId: current.slackUserId ?? next.slackUserId }
      : {}),
    ...((current.slackUserName ?? next.slackUserName)
      ? { slackUserName: current.slackUserName ?? next.slackUserName }
      : {}),
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

/** Read verified actor conversation rows directly from the SQL identity model. */
export async function actorRows(email?: string) {
  const normalizedEmail = normalizeEmail(email);
  const rows = await getDb()
    .select({
      channelName: juniorConversations.channelName,
      conversationId: juniorConversations.conversationId,
      createdAt: juniorConversations.createdAt,
      destinationId: juniorDestinations.id,
      destinationVisibility: juniorDestinations.visibility,
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
    .where(
      and(
        eq(juniorIdentities.provider, "slack"),
        eq(juniorIdentities.emailVerified, true),
        sql`${juniorUsers.primaryEmailNormalized} IS NOT NULL`,
        normalizedEmail
          ? eq(juniorUsers.primaryEmailNormalized, normalizedEmail)
          : undefined,
      ),
    )
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(SAMPLE_LIMIT + 1);
  return {
    rows: rows.slice(0, SAMPLE_LIMIT),
    truncated: rows.length > SAMPLE_LIMIT,
  };
}

export type PeopleConversationRow = Awaited<
  ReturnType<typeof actorRows>
>["rows"][number];
