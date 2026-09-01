import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { conversationAggregateColumns } from "./aggregate";
import type {
  ConversationMetricDay,
  ConversationStatsItem,
  ConversationStatsReport,
  GuardianMetricDay,
  GuardianStats,
} from "../schema/conversation";
import {
  WINDOW_SEVEN_DAY_HOURS,
  sumUtcHoursIntoSixHours,
  startOfUtcHour,
  utcHourKey,
} from "../reporting-window";

const WINDOW_DAYS = 90;
const treeConversation = alias(juniorConversations, "stats_tree_conversation");
const treeAggregateColumns = conversationAggregateColumns({
  metrics: treeConversation,
  roots: juniorConversations,
});

function emptyStatsItem(label: string): ConversationStatsItem {
  return {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    label,
  };
}

function addUsd(current: number | undefined, next: number): number {
  return Math.round(((current ?? 0) + next) * 1e12) / 1e12;
}

function actorLabel(row: {
  identityDisplayName: string | null;
  identityEmail: string | null;
  identityHandle: string | null;
  identitySubjectId: string | null;
  userDisplayName: string | null;
  userEmail: string | null;
}): string {
  return (
    row.userEmail?.trim() ||
    row.identityEmail?.trim() ||
    row.userDisplayName?.trim() ||
    row.identityDisplayName?.trim() ||
    row.identityHandle?.trim() ||
    row.identitySubjectId?.trim() ||
    "Unknown"
  );
}

function surfaceLabel(source: string | null): string {
  if (source === "scheduler") return "Scheduler";
  if (source === "api" || source === "web") return "Web";
  if (source === "internal" || source === "local") return "Internal";
  return "Conversation";
}

/** Collapse private Slack destinations before any stored name reaches stats. */
function locationLabel(row: {
  channelName: string | null;
  destinationDisplayName: string | null;
  destinationKind: string | null;
  destinationProvider: string | null;
  destinationVisibility: string | null;
  source: string | null;
}): string {
  if (row.destinationProvider !== "slack") {
    return surfaceLabel(row.source);
  }
  if (row.destinationKind === "dm") {
    return "Direct Message";
  }
  if (row.destinationVisibility !== "public") {
    return "Private Conversation";
  }
  const name = (row.channelName ?? row.destinationDisplayName)
    ?.trim()
    .replace(/^#/, "");
  return name ? `#${name}` : "Public Channel";
}

type AggregateRow = {
  active: number;
  cachedInputTokens: number | null;
  conversations: number;
  costUsd: number | null;
  durationMs: number;
  failed: number;
  inputTokens: number | null;
  tokens: number | null;
};

function addAggregate(
  map: Map<string, ConversationStatsItem>,
  label: string,
  row: AggregateRow,
): void {
  const item = map.get(label) ?? emptyStatsItem(label);
  item.active += row.active;
  item.conversations += row.conversations;
  item.durationMs += row.durationMs;
  item.failed += row.failed;
  if (row.tokens !== null) {
    item.tokens = (item.tokens ?? 0) + row.tokens;
  }
  if (row.costUsd !== null) {
    item.costUsd = addUsd(item.costUsd, row.costUsd);
  }
  map.set(label, item);
}

function statsItems(map: Map<string, ConversationStatsItem>) {
  return [...map.values()].sort(
    (left, right) =>
      right.conversations - left.conversations ||
      left.label.localeCompare(right.label),
  );
}

function statsWhere(start: Date, end: Date) {
  return and(
    isNull(juniorConversations.parentConversationId),
    gte(juniorConversations.lastActivityAt, start),
    lte(juniorConversations.lastActivityAt, end),
  );
}

function statsWindow(nowMs: number) {
  const end = new Date(nowMs);
  const start = new Date(nowMs);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  return { end, start };
}

const HOUR_MS = 60 * 60 * 1_000;
/** Keep 7d of hours so clients can roll 7d charts into 6h buckets. */
const WINDOW_HOURS = WINDOW_SEVEN_DAY_HOURS;

type MetricRow = {
  cachedInputTokens: number | null;
  conversations: number;
  costUsd: number | null;
  date: string;
  durationMs: number;
  inputTokens: number | null;
  tokens: number | null;
};

type GuardianRow = {
  allow: number;
  ask: number;
  costUsd: number | null;
  date: string;
  deny: number;
  requests: number;
};


function metricPoint(
  date: string,
  row:
    | {
        cachedInputTokens?: number | null;
        conversations?: number;
        costUsd?: number | null;
        durationMs?: number;
        inputTokens?: number | null;
        tokens?: number | null;
      }
    | undefined,
): ConversationMetricDay {
  return {
    conversations: row?.conversations ?? 0,
    date,
    durationMs: row?.durationMs ?? 0,
    ...(row?.cachedInputTokens !== null && row?.cachedInputTokens !== undefined
      ? { cachedInputTokens: row.cachedInputTokens }
      : undefined),
    ...(row?.costUsd !== null && row?.costUsd !== undefined
      ? { costUsd: addUsd(undefined, row.costUsd) }
      : undefined),
    ...(row?.inputTokens !== null && row?.inputTokens !== undefined
      ? { inputTokens: row.inputTokens }
      : undefined),
    ...(row?.tokens !== null && row?.tokens !== undefined
      ? { tokens: row.tokens }
      : undefined),
  };
}

function metricDays(rows: MetricRow[], endMs: number): ConversationMetricDay[] {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const end = new Date(endMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  const days: ConversationMetricDay[] = [];
  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    days.push(metricPoint(date, byDate.get(date)));
  }
  return days;
}


function emptyMetricDay(date: string): ConversationMetricDay {
  return { conversations: 0, date, durationMs: 0 };
}

function emptyGuardianDay(date: string): GuardianMetricDay {
  return { allow: 0, ask: 0, date, deny: 0, requests: 0 };
}

function sumMetricHoursIntoSixHours(
  hours: ConversationMetricDay[],
  endMs: number,
): ConversationMetricDay[] {
  return sumUtcHoursIntoSixHours({
    empty: emptyMetricDay,
    hours,
    nowMs: endMs,
  });
}

function sumGuardianHoursIntoSixHours(
  hours: GuardianMetricDay[],
  endMs: number,
): GuardianMetricDay[] {
  return sumUtcHoursIntoSixHours({
    empty: emptyGuardianDay,
    hours,
    nowMs: endMs,
  });
}


function metricHours(rows: MetricRow[], endMs: number): ConversationMetricDay[] {
  const byHour = new Map(rows.map((row) => [row.date, row]));
  const end = startOfUtcHour(endMs);
  const start = new Date(end.getTime() - (WINDOW_HOURS - 1) * HOUR_MS);
  const hours: ConversationMetricDay[] = [];
  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setTime(cursor.getTime() + HOUR_MS)
  ) {
    const date = utcHourKey(cursor);
    hours.push(metricPoint(date, byHour.get(date)));
  }
  return hours;
}

function guardianPoint(
  date: string,
  row: GuardianRow | undefined,
): GuardianMetricDay {
  return {
    allow: row?.allow ?? 0,
    ask: row?.ask ?? 0,
    date,
    deny: row?.deny ?? 0,
    requests: row?.requests ?? 0,
    ...(row?.costUsd !== null && row?.costUsd !== undefined
      ? { costUsd: row.costUsd }
      : undefined),
  };
}

function guardianStats(
  dayRows: GuardianRow[],
  hourRows: GuardianRow[],
  endMs: number,
): GuardianStats {
  const byDate = new Map(dayRows.map((row) => [row.date, row]));
  const end = new Date(endMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  const metricDays: GuardianMetricDay[] = [];
  let allow = 0;
  let ask = 0;
  let deny = 0;
  let requests = 0;
  let costUsd: number | undefined;

  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    const row = byDate.get(date);
    allow += row?.allow ?? 0;
    ask += row?.ask ?? 0;
    deny += row?.deny ?? 0;
    requests += row?.requests ?? 0;
    if (row?.costUsd !== null && row?.costUsd !== undefined) {
      costUsd = addUsd(costUsd, row.costUsd);
    }
    metricDays.push(guardianPoint(date, row));
  }

  const byHour = new Map(hourRows.map((row) => [row.date, row]));
  const hourEnd = startOfUtcHour(endMs);
  const hourStart = new Date(hourEnd.getTime() - (WINDOW_HOURS - 1) * HOUR_MS);
  const metricHours: GuardianMetricDay[] = [];
  for (
    const cursor = new Date(hourStart);
    cursor.getTime() <= hourEnd.getTime();
    cursor.setTime(cursor.getTime() + HOUR_MS)
  ) {
    const date = utcHourKey(cursor);
    metricHours.push(guardianPoint(date, byHour.get(date)));
  }

  return {
    allow,
    ask,
    deny,
    metricDays,
    metricHours,
    metricSixHours: sumGuardianHoursIntoSixHours(metricHours, endMs),
    requests,
    ...(costUsd !== undefined ? { costUsd } : undefined),
  };
}

async function aggregateStats(db: JuniorDatabase, start: Date, end: Date) {
  const where = statsWhere(start, end);
  const activityDate = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  const activityHour = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24'
  )`;
  const [
    totalsRows,
    actorRows,
    locationRows,
    metricRows,
    metricHourRows,
  ] = await Promise.all([
    db
      .select(treeAggregateColumns)
      .from(juniorConversations)
      .innerJoin(
        treeConversation,
        eq(
          treeConversation.rootConversationId,
          juniorConversations.conversationId,
        ),
      )
      .where(where),
    db
      .select({
        identityDisplayName: juniorIdentities.displayName,
        identityEmail: juniorIdentities.emailNormalized,
        identityHandle: juniorIdentities.handle,
        identitySubjectId: juniorIdentities.providerSubjectId,
        userDisplayName: juniorUsers.displayName,
        userEmail: juniorUsers.primaryEmailNormalized,
        ...treeAggregateColumns,
      })
      .from(juniorConversations)
      .innerJoin(
        treeConversation,
        eq(
          treeConversation.rootConversationId,
          juniorConversations.conversationId,
        ),
      )
      .leftJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(where)
      .groupBy(
        juniorIdentities.displayName,
        juniorIdentities.emailNormalized,
        juniorIdentities.handle,
        juniorIdentities.providerSubjectId,
        juniorUsers.displayName,
        juniorUsers.primaryEmailNormalized,
      ),
    db
      .select({
        channelName: juniorConversations.channelName,
        destinationDisplayName: juniorDestinations.displayName,
        destinationKind: juniorDestinations.kind,
        destinationProvider: juniorDestinations.provider,
        destinationVisibility: juniorDestinations.visibility,
        source: juniorConversations.source,
        ...treeAggregateColumns,
      })
      .from(juniorConversations)
      .innerJoin(
        treeConversation,
        eq(
          treeConversation.rootConversationId,
          juniorConversations.conversationId,
        ),
      )
      .leftJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .where(where)
      .groupBy(
        juniorConversations.channelName,
        juniorConversations.source,
        juniorDestinations.displayName,
        juniorDestinations.kind,
        juniorDestinations.provider,
        juniorDestinations.visibility,
      ),
    db
      .select({
        cachedInputTokens: treeAggregateColumns.cachedInputTokens,
        conversations: treeAggregateColumns.conversations,
        costUsd: treeAggregateColumns.costUsd,
        date: activityDate,
        durationMs: treeAggregateColumns.durationMs,
        inputTokens: treeAggregateColumns.inputTokens,
        tokens: treeAggregateColumns.tokens,
      })
      .from(juniorConversations)
      .innerJoin(
        treeConversation,
        eq(
          treeConversation.rootConversationId,
          juniorConversations.conversationId,
        ),
      )
      .where(where)
      .groupBy(activityDate),
    db
      .select({
        cachedInputTokens: treeAggregateColumns.cachedInputTokens,
        conversations: treeAggregateColumns.conversations,
        costUsd: treeAggregateColumns.costUsd,
        date: activityHour,
        durationMs: treeAggregateColumns.durationMs,
        inputTokens: treeAggregateColumns.inputTokens,
        tokens: treeAggregateColumns.tokens,
      })
      .from(juniorConversations)
      .innerJoin(
        treeConversation,
        eq(
          treeConversation.rootConversationId,
          juniorConversations.conversationId,
        ),
      )
      .where(where)
      .groupBy(activityHour),
  ]);
  return {
    actorRows,
    locationRows,
    metricHourRows,
    metricRows,
    totals: totalsRows[0],
  };
}

async function aggregateGuardianStats(
  db: JuniorDatabase,
  start: Date,
  end: Date,
) {
  const day = sql<string>`TO_CHAR(
    ${juniorConversationEvents.createdAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  const hour = sql<string>`TO_CHAR(
    ${juniorConversationEvents.createdAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24'
  )`;
  const decision = sql`${juniorConversationEvents.payload}->>'decision'`;
  const cost = sql<number | null>`CASE
    WHEN jsonb_typeof(${juniorConversationEvents.payload}->'costUsd') = 'number'
      THEN (${juniorConversationEvents.payload}->>'costUsd')::double precision
    ELSE NULL
  END`;
  const selectColumns = {
    allow: sql<number>`COUNT(*) FILTER (WHERE ${decision} = 'allow')::integer`,
    ask: sql<number>`COUNT(*) FILTER (WHERE ${decision} = 'ask')::integer`,
    costUsd: sql<number | null>`SUM(${cost})::double precision`,
    deny: sql<number>`COUNT(*) FILTER (WHERE ${decision} = 'deny')::integer`,
    requests: sql<number>`COUNT(*)::integer`,
  };
  const where = and(
    eq(juniorConversationEvents.type, "guardian_action_reviewed"),
    gte(juniorConversationEvents.createdAt, start),
    lte(juniorConversationEvents.createdAt, end),
  );
  const [dayRows, hourRows] = await Promise.all([
    db
      .select({ ...selectColumns, date: day })
      .from(juniorConversationEvents)
      .where(where)
      .groupBy(day),
    db
      .select({ ...selectColumns, date: hour })
      .from(juniorConversationEvents)
      .where(where)
      .groupBy(hour),
  ]);
  return { dayRows, hourRows };
}

/** Build complete 90-day dashboard stats from normalized durable SQL records. */
export async function readConversationStatsFromSql(): Promise<ConversationStatsReport> {
  const nowMs = Date.now();
  const { end, start } = statsWindow(nowMs);
  const db = getDb();
  const [
    { actorRows, locationRows, metricHourRows, metricRows, totals },
    guardian,
  ] = await Promise.all([
    aggregateStats(db, start, end),
    aggregateGuardianStats(db, start, end),
  ]);
  const actors = new Map<string, ConversationStatsItem>();
  const locations = new Map<string, ConversationStatsItem>();

  for (const row of actorRows) {
    addAggregate(actors, actorLabel(row), row);
  }
  for (const row of locationRows) {
    addAggregate(locations, locationLabel(row), row);
  }

  return {
    active: totals?.active ?? 0,
    ...(totals?.cachedInputTokens !== null &&
    totals?.cachedInputTokens !== undefined
      ? { cachedInputTokens: totals.cachedInputTokens }
      : undefined),
    conversations: totals?.conversations ?? 0,
    durationMs: totals?.durationMs ?? 0,
    failed: totals?.failed ?? 0,
    generatedAt: new Date(nowMs).toISOString(),
    guardian: guardianStats(guardian.dayRows, guardian.hourRows, nowMs),
    metricDays: metricDays(metricRows, nowMs),
    ...(() => {
      const hours = metricHours(metricHourRows, nowMs);
      return {
        metricHours: hours,
        metricSixHours: sumMetricHoursIntoSixHours(hours, nowMs),
      };
    })(),
    locations: statsItems(locations),
    actors: statsItems(actors),
    source: "conversation_index",
    ...(totals?.costUsd !== null && totals?.costUsd !== undefined
      ? { costUsd: addUsd(undefined, totals.costUsd) }
      : undefined),
    ...(totals?.inputTokens !== null && totals?.inputTokens !== undefined
      ? { inputTokens: totals.inputTokens }
      : undefined),
    ...(totals?.tokens !== null && totals?.tokens !== undefined
      ? { tokens: totals.tokens }
      : undefined),
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}
