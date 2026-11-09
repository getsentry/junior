import type { User } from "@sentry/junior-plugin-api";
import { and, eq, gte, sql } from "drizzle-orm";
import { readAutomationTitlesByConversationId } from "@/chat/automations/execution-stats";
import { getDb } from "@/chat/db";
import {
  juniorConversationMetrics,
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
import { readConversationAccessFromSql } from "../conversations/access";
import { readFirstHumanMessageTexts } from "../conversations/first-message";
import { readConversationTreeMetricsFromSql } from "../conversations/usage";
import type {
  ConversationStatsItem,
  ActorActivityDayReport,
  ActorIdentity,
  ActorProfileReport,
} from "../schema/person";
import {
  ACTIVITY_DAYS,
  activityDays,
  activityHours,
  activitySixHours,
  emptyActivityDay,
  emptyTotals,
  normalizeEmail,
  recentActorRows,
  slackActorColumns,
  statsItems,
  turnMetricColumns,
  turnMetricRoot,
  turnMetricRootJoin,
  verifiedActorWhere,
} from "./shared";
import { trailingUtcHourWindow } from "../reporting-window";

type AggregateRow = {
  active?: number;
  conversations?: number;
  durationMs?: number;
  failed?: number;
  tokens?: number | null;
};

type ConversationTable = typeof juniorConversations | typeof turnMetricRoot;

function emptyProfile(email: string, nowMs: number): ActorProfileReport {
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (ACTIVITY_DAYS - 1));
  return {
    activityDays: activityDays(new Map(), nowMs),
    activityHours: activityHours(new Map(), nowMs),
    activitySixHours: activitySixHours(new Map(), nowMs),
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
  item.active += row.active ?? 0;
  item.conversations += row.conversations ?? 0;
  item.durationMs += row.durationMs ?? 0;
  item.failed += row.failed ?? 0;
  if (row.tokens != null) item.tokens = (item.tokens ?? 0) + row.tokens;
  map.set(label, item);
}

function surfaceExpression(table: ConversationTable) {
  return sql<string>`CASE
    WHEN ${table.source} IN ('api', 'scheduler', 'slack')
      THEN ${table.source}
    -- Dashboard web conversations share the product api surface label.
    WHEN ${table.source} = 'web' THEN 'api'
    WHEN ${table.conversationId} LIKE 'slack:%' THEN 'slack'
    WHEN ${table.conversationId} LIKE 'scheduler:%' THEN 'scheduler'
    WHEN ${table.conversationId} LIKE 'api:%' THEN 'api'
    ELSE 'internal'
  END`;
}

function channelExpression(table: ConversationTable) {
  return sql<string>`SPLIT_PART(${table.conversationId}, ':', 2)`;
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

function activityBuckets(
  startedRows: {
    active: number;
    conversations: number;
    date: string;
    failed: number;
  }[],
  turnRows: {
    costUsd: number | null;
    date: string;
    durationMs: number;
    tokens: number | null;
  }[],
): Map<string, ActorActivityDayReport> {
  const buckets = new Map<string, ActorActivityDayReport>();
  for (const row of startedRows) {
    buckets.set(row.date, { ...emptyActivityDay(row.date), ...row });
  }
  for (const row of turnRows) {
    buckets.set(row.date, {
      ...(buckets.get(row.date) ?? emptyActivityDay(row.date)),
      ...(row.costUsd !== null ? { costUsd: row.costUsd } : undefined),
      durationMs: row.durationMs,
      ...(row.tokens !== null ? { tokens: row.tokens } : undefined),
    });
  }
  return buckets;
}

/** Load one complete person profile while bounding only its recent-conversation list. */
export async function readPeopleProfileFromSql(
  email: string,
  options: { viewer?: User } = {},
): Promise<ActorProfileReport> {
  const nowMs = Date.now();
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return emptyProfile("", nowMs);

  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (ACTIVITY_DAYS - 1));
  const where = verifiedActorWhere(normalizedEmail);
  const surface = surfaceExpression(juniorConversations);
  const activityDate = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  const activityHour = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
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
  const channel = channelExpression(juniorConversations);
  const turnSurface = surfaceExpression(turnMetricRoot);
  const turnChannel = channelExpression(turnMetricRoot);
  const hourWindow = trailingUtcHourWindow(nowMs, 7 * 24);
  // Conversation counts belong to the Actor that started each Conversation.
  // Spend, duration, and tokens belong to the Actor of each Turn.
  const { active, conversations, failed } = conversationAggregateColumns();
  const [
    totalsRows,
    turnTotalsRows,
    dayRows,
    turnDayRows,
    hourRows,
    turnHourRows,
    locationRows,
    turnLocationRows,
    surfaceRows,
    turnSurfaceRows,
    recentRows,
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
        email: juniorUsers.primaryEmailNormalized,
        fullName: juniorUsers.displayName,
        ...slackActorColumns(),
        ...turnMetricColumns,
      })
      .from(juniorConversationMetrics)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversationMetrics.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(where)
      .groupBy(juniorUsers.primaryEmailNormalized, juniorUsers.displayName),
    getDb()
      .select({ date: activityDate, active, conversations, failed })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(and(where, gte(juniorConversations.lastActivityAt, start)))
      .groupBy(activityDate),
    getDb()
      .select({ date: metricDate, ...turnMetricColumns })
      .from(juniorConversationMetrics)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversationMetrics.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(and(where, gte(juniorConversationMetrics.occurredAt, start)))
      .groupBy(metricDate),
    getDb()
      .select({ date: activityHour, active, conversations, failed })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(
        and(where, gte(juniorConversations.lastActivityAt, hourWindow.start)),
      )
      .groupBy(activityHour),
    getDb()
      .select({ date: metricHour, ...turnMetricColumns })
      .from(juniorConversationMetrics)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversationMetrics.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(
        and(where, gte(juniorConversationMetrics.occurredAt, hourWindow.start)),
      )
      .groupBy(metricHour),
    getDb()
      .select({
        channel,
        channelName: juniorConversations.channelName,
        destinationVisibility: juniorDestinations.visibility,
        surface,
        active,
        conversations,
        failed,
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
      .select({
        channel: turnChannel,
        channelName: turnMetricRoot.channelName,
        destinationVisibility: juniorDestinations.visibility,
        surface: turnSurface,
        ...turnMetricColumns,
      })
      .from(juniorConversationMetrics)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversationMetrics.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .innerJoin(turnMetricRoot, turnMetricRootJoin())
      .leftJoin(
        juniorDestinations,
        eq(juniorDestinations.id, turnMetricRoot.destinationId),
      )
      .where(where)
      .groupBy(
        turnChannel,
        turnMetricRoot.channelName,
        juniorDestinations.visibility,
        turnSurface,
      ),
    getDb()
      .select({ surface, active, conversations, failed })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(where)
      .groupBy(surface),
    getDb()
      .select({ surface: turnSurface, ...turnMetricColumns })
      .from(juniorConversationMetrics)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversationMetrics.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .innerJoin(turnMetricRoot, turnMetricRootJoin())
      .where(where)
      .groupBy(turnSurface),
    recentActorRows(normalizedEmail),
  ]);

  const startedTotals = totalsRows[0];
  const turnTotals = turnTotalsRows[0];
  const person = startedTotals ?? turnTotals;
  if (!person) return emptyProfile(normalizedEmail, nowMs);

  const actor: ActorIdentity & { email: string } = {
    email: person.email,
    ...(person.fullName ? { fullName: person.fullName } : undefined),
    ...(person.slackUserId ? { slackUserId: person.slackUserId } : undefined),
    ...(person.slackUserName
      ? { slackUserName: person.slackUserName }
      : undefined),
  };
  const days = activityBuckets(dayRows, turnDayRows);
  const hours = activityBuckets(hourRows, turnHourRows);
  const locations = new Map<string, ConversationStatsItem>();
  for (const row of [...locationRows, ...turnLocationRows]) {
    addAggregate(locations, locationLabel(row), row);
  }
  const surfaces = new Map<string, ConversationStatsItem>();
  for (const row of [...surfaceRows, ...turnSurfaceRows]) {
    addAggregate(
      surfaces,
      surfaceLabel(row.surface as "api" | "internal" | "scheduler" | "slack"),
      row,
    );
  }
  const recentConversationIds = recentRows.map((row) => row.conversationId);
  const [
    accessByConversation,
    metricsByRoot,
    automationTitleByConversation,
    firstHumanMessageTextByConversation,
  ] = await Promise.all([
    readConversationAccessFromSql(
      getDb(),
      recentConversationIds,
      options.viewer,
    ),
    readConversationTreeMetricsFromSql(getDb(), recentConversationIds),
    readAutomationTitlesByConversationId(recentRows),
    readFirstHumanMessageTexts(getDb(), recentRows),
  ]);

  return {
    activityDays: activityDays(days, nowMs),
    activityHours: activityHours(hours, nowMs),
    activitySixHours: activitySixHours(hours, nowMs),
    generatedAt: new Date(nowMs).toISOString(),
    locations: statsItems(locations),
    recentConversations: recentRows.map((row) =>
      summaryFromRow(row, {
        access: accessByConversation.get(row.conversationId),
        automationTitle: automationTitleByConversation.get(row.conversationId),
        firstHumanMessageText: firstHumanMessageTextByConversation.get(
          row.conversationId,
        ),
        metrics: metricsByRoot.get(row.conversationId),
      }),
    ),
    actor,
    source: "conversation_index",
    surfaces: statsItems(surfaces),
    totals: {
      active: startedTotals?.active ?? 0,
      activeDays: startedTotals?.activeDays ?? 0,
      conversations: startedTotals?.conversations ?? 0,
      durationMs: turnTotals?.durationMs ?? 0,
      failed: startedTotals?.failed ?? 0,
      ...(turnTotals && turnTotals.tokens !== null
        ? { tokens: turnTotals.tokens }
        : undefined),
    },
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}
