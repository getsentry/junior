import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import {
  conversationActiveDaysColumn,
  conversationAggregateColumns,
} from "../conversations/aggregate";
import {
  slackLocationLabel,
  summaryFromRow,
  surfaceLabel,
} from "../conversations/reporting";
import type {
  ConversationStatsItem,
  ActorActivityDayReport,
  ActorIdentity,
  ActorProfileReport,
} from "./schema";
import {
  ACTIVITY_DAYS,
  activityDays,
  emptyTotals,
  normalizeEmail,
  recentActorRows,
  statsItems,
  verifiedActorWhere,
} from "./shared";

type AggregateRow = {
  active: number;
  conversations: number;
  durationMs: number;
  failed: number;
  tokens: number | null;
};

function emptyProfile(email: string, nowMs: number): ActorProfileReport {
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (ACTIVITY_DAYS - 1));
  return {
    activityDays: activityDays(new Map(), nowMs),
    generatedAt: new Date(nowMs).toISOString(),
    locations: [],
    recentConversations: [],
    actor: { email },
    source: "conversation_index",
    surfaces: [],
    totals: emptyTotals(),
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}

function addAggregate(
  map: Map<string, ConversationStatsItem>,
  label: string,
  row: AggregateRow,
): void {
  const item = map.get(label) ?? {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    label,
  };
  item.active += row.active;
  item.conversations += row.conversations;
  item.durationMs += row.durationMs;
  item.failed += row.failed;
  if (row.tokens !== null) item.tokens = (item.tokens ?? 0) + row.tokens;
  map.set(label, item);
}

function surfaceExpression() {
  return sql<string>`CASE
    WHEN ${juniorConversations.source} IN ('api', 'scheduler', 'slack')
      THEN ${juniorConversations.source}
    WHEN ${juniorConversations.conversationId} LIKE 'slack:%' THEN 'slack'
    WHEN ${juniorConversations.conversationId} LIKE 'scheduler:%' THEN 'scheduler'
    WHEN ${juniorConversations.conversationId} LIKE 'api:%' THEN 'api'
    ELSE 'internal'
  END`;
}

function locationLabel(row: {
  channel: string;
  channelName: string | null;
  destinationVisibility: string | null;
  surface: string;
}): string {
  if (row.surface !== "slack")
    return surfaceLabel(row.surface as "api" | "internal" | "scheduler");
  if (row.destinationVisibility !== "public") return "Private Conversation";
  return (
    slackLocationLabel({
      channel: row.channel || undefined,
      channelName: row.channelName ?? undefined,
    }) ?? "Conversation"
  );
}

/** Load one complete person profile while bounding only its recent-conversation list. */
export async function readPeopleProfileFromSql(
  email: string,
): Promise<ActorProfileReport> {
  const nowMs = Date.now();
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return emptyProfile("", nowMs);

  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (ACTIVITY_DAYS - 1));
  const where = verifiedActorWhere(normalizedEmail);
  const surface = surfaceExpression();
  const activityDate = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  const channel = sql<string>`SPLIT_PART(${juniorConversations.conversationId}, ':', 2)`;

  const [totalsRows, dayRows, locationRows, surfaceRows, recentRows] =
    await Promise.all([
      getDb()
        .select({
          email: juniorUsers.primaryEmailNormalized,
          fullName: juniorUsers.displayName,
          slackUserId: sql<
            string | null
          >`MAX(${juniorIdentities.providerSubjectId})`,
          slackUserName: sql<string | null>`MAX(${juniorIdentities.handle})`,
          activeDays: conversationActiveDaysColumn(),
          ...conversationAggregateColumns(),
        })
        .from(juniorConversations)
        .innerJoin(
          juniorIdentities,
          eq(juniorIdentities.id, juniorConversations.actorIdentityId),
        )
        .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
        .where(where)
        .groupBy(juniorUsers.primaryEmailNormalized, juniorUsers.displayName),
      getDb()
        .select({
          date: activityDate,
          ...conversationAggregateColumns(),
        })
        .from(juniorConversations)
        .innerJoin(
          juniorIdentities,
          eq(juniorIdentities.id, juniorConversations.actorIdentityId),
        )
        .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
        .where(and(where, gte(juniorConversations.lastActivityAt, start)))
        .groupBy(activityDate),
      getDb()
        .select({
          channel,
          channelName: juniorConversations.channelName,
          destinationVisibility: juniorDestinations.visibility,
          surface,
          ...conversationAggregateColumns(),
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
        .where(where)
        .groupBy(
          channel,
          juniorConversations.channelName,
          juniorDestinations.visibility,
          surface,
        ),
      getDb()
        .select({ surface, ...conversationAggregateColumns() })
        .from(juniorConversations)
        .innerJoin(
          juniorIdentities,
          eq(juniorIdentities.id, juniorConversations.actorIdentityId),
        )
        .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
        .where(where)
        .groupBy(surface),
      recentActorRows(normalizedEmail),
    ]);

  const totalsRow = totalsRows[0];
  if (!totalsRow) return emptyProfile(normalizedEmail, nowMs);

  const actor: ActorIdentity & { email: string } = {
    email: totalsRow.email,
    ...(totalsRow.fullName ? { fullName: totalsRow.fullName } : {}),
    ...(totalsRow.slackUserId ? { slackUserId: totalsRow.slackUserId } : {}),
    ...(totalsRow.slackUserName
      ? { slackUserName: totalsRow.slackUserName }
      : {}),
  };
  const days = new Map<string, ActorActivityDayReport>();
  for (const row of dayRows) {
    days.set(row.date, {
      active: row.active,
      conversations: row.conversations,
      date: row.date,
      durationMs: row.durationMs,
      failed: row.failed,
      ...(row.tokens !== null ? { tokens: row.tokens } : {}),
    });
  }
  const locations = new Map<string, ConversationStatsItem>();
  for (const row of locationRows) {
    addAggregate(locations, locationLabel(row), row);
  }
  const surfaces = new Map<string, ConversationStatsItem>();
  for (const row of surfaceRows) {
    addAggregate(
      surfaces,
      surfaceLabel(row.surface as "api" | "internal" | "scheduler" | "slack"),
      row,
    );
  }

  return {
    activityDays: activityDays(days, nowMs),
    generatedAt: new Date(nowMs).toISOString(),
    locations: statsItems(locations),
    recentConversations: recentRows.map(summaryFromRow),
    actor,
    source: "conversation_index",
    surfaces: statsItems(surfaces),
    totals: {
      active: totalsRow.active,
      activeDays: totalsRow.activeDays,
      conversations: totalsRow.conversations,
      durationMs: totalsRow.durationMs,
      failed: totalsRow.failed,
      ...(totalsRow.tokens !== null ? { tokens: totalsRow.tokens } : {}),
    },
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}
