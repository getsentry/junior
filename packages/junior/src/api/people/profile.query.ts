import type { User } from "@sentry/junior-plugin-api";
import { eq, gte, sql } from "drizzle-orm";
import { readAutomationTitlesByConversationId } from "@/chat/automations/execution-stats";
import { getDb } from "@/chat/db";
import { juniorDestinations } from "@/db/schema";
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
  personTurns,
  recentActorRows,
  statsItems,
  turnAggregateColumns,
  turnBucket,
  turnPersonColumns,
  turnRoot,
  turnRootJoin,
} from "./shared";
import { trailingUtcHourWindow } from "../reporting-window";

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
  item.active += row.active;
  item.conversations += row.conversations;
  item.durationMs += row.durationMs;
  item.failed += row.failed;
  if (row.tokens !== null) item.tokens = (item.tokens ?? 0) + row.tokens;
  map.set(label, item);
}

function surfaceExpression(table: typeof turnRoot) {
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

function channelExpression(table: typeof turnRoot) {
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
  rows: (AggregateRow & { costUsd: number | null; date: string })[],
): Map<string, ActorActivityDayReport> {
  return new Map(
    rows.map(({ costUsd, tokens, ...row }) => [
      row.date,
      {
        ...emptyActivityDay(row.date),
        ...row,
        ...(costUsd !== null ? { costUsd } : undefined),
        ...(tokens !== null ? { tokens } : undefined),
      },
    ]),
  );
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
  const turns = personTurns(normalizedEmail);
  const aggregate = turnAggregateColumns(turns);
  const surface = surfaceExpression(turnRoot);
  const channel = channelExpression(turnRoot);
  const day = turnBucket(turns, "day");
  const hour = turnBucket(turns, "hour");
  const hourWindow = trailingUtcHourWindow(nowMs, 7 * 24);
  const [totalsRows, dayRows, hourRows, locationRows, surfaceRows, recentRows] =
    await Promise.all([
      getDb()
        .select({ ...turnPersonColumns(turns), ...aggregate })
        .from(turns)
        .innerJoin(turnRoot, turnRootJoin(turns))
        .groupBy(turns.email, turns.fullName),
      getDb()
        .select({ date: day, ...aggregate })
        .from(turns)
        .innerJoin(turnRoot, turnRootJoin(turns))
        .where(gte(turns.occurredAt, start))
        .groupBy(day),
      getDb()
        .select({ date: hour, ...aggregate })
        .from(turns)
        .innerJoin(turnRoot, turnRootJoin(turns))
        .where(gte(turns.occurredAt, hourWindow.start))
        .groupBy(hour),
      getDb()
        .select({
          channel,
          channelName: turnRoot.channelName,
          destinationVisibility: juniorDestinations.visibility,
          surface,
          ...aggregate,
        })
        .from(turns)
        .innerJoin(turnRoot, turnRootJoin(turns))
        .leftJoin(
          juniorDestinations,
          eq(juniorDestinations.id, turnRoot.destinationId),
        )
        .groupBy(
          channel,
          turnRoot.channelName,
          juniorDestinations.visibility,
          surface,
        ),
      getDb()
        .select({ surface, ...aggregate })
        .from(turns)
        .innerJoin(turnRoot, turnRootJoin(turns))
        .groupBy(surface),
      recentActorRows(normalizedEmail),
    ]);

  const person = totalsRows[0];
  if (!person) return emptyProfile(normalizedEmail, nowMs);

  const actor: ActorIdentity & { email: string } = {
    email: person.email,
    ...(person.fullName ? { fullName: person.fullName } : undefined),
    ...(person.slackUserId ? { slackUserId: person.slackUserId } : undefined),
    ...(person.slackUserName
      ? { slackUserName: person.slackUserName }
      : undefined),
  };
  const days = activityBuckets(dayRows);
  const hours = activityBuckets(hourRows);
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
      active: person.active,
      activeDays: person.activeDays,
      conversations: person.conversations,
      durationMs: person.durationMs,
      failed: person.failed,
      ...(person.tokens !== null ? { tokens: person.tokens } : undefined),
    },
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}
