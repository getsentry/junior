import type { User } from "@sentry/junior-plugin-api";
import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import {
  activityDays,
  activityHours,
  activitySixHours,
  type DailyConversationActivity,
} from "../activity";
import {
  WINDOW_SEVEN_DAY_HOURS,
  fillUtcDays,
  fillUtcHours,
  sumUtcHoursIntoSixHours,
  trailingUtcDayWindow,
  trailingUtcHourWindow,
} from "../reporting-window";
import {
  conversationAggregateColumns,
  conversationRangeColumns,
} from "../conversations/aggregate";
import type { ActorIdentity } from "../schema/conversation";
import { readConversationAccessFromSql } from "../conversations/access";
import { summaryFromRow } from "../conversations/reporting";
import { readRootConversationMetricsFromSql } from "../conversations/usage";
import type {
  LocationActorSummaryReport,
  LocationActivityDayReport,
  LocationDetailReport,
  LocationDirectoryReport,
  LocationSummaryReport,
} from "../schema/location";

const RECENT_LIMIT = 25;
const ACTIVITY_DAYS = 90;
const treeConversation = alias(
  juniorConversations,
  "location_tree_conversation",
);
const treeAggregateColumns = conversationAggregateColumns({
  metrics: treeConversation,
  roots: juniorConversations,
});

type AggregateMetrics = Pick<
  LocationSummaryReport,
  "active" | "conversations" | "costUsd" | "durationMs" | "failed" | "tokens"
>;

type AggregateRow = {
  active: number;
  conversations: number;
  costUsd: number | null;
  durationMs: number;
  failed: number;
  tokens: number | null;
};

function emptyMetrics(): AggregateMetrics {
  return {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
  };
}

function addMetrics(target: AggregateMetrics, row: AggregateRow): void {
  target.active += row.active;
  target.conversations += row.conversations;
  target.durationMs += row.durationMs;
  target.failed += row.failed;
  if (row.tokens !== null) {
    target.tokens = (target.tokens ?? 0) + row.tokens;
  }
  if (row.costUsd !== null) {
    target.costUsd =
      Math.round(((target.costUsd ?? 0) + row.costUsd) * 1e12) / 1e12;
  }
}

function publicLabel(input: {
  displayName: string | null;
  providerDestinationId: string;
}): string {
  const name = input.displayName?.trim().replace(/^#/, "");
  return name ? `#${name}` : `Public channel ${input.providerDestinationId}`;
}

function actorLabel(actor: ActorIdentity): string {
  return (
    actor.email?.trim() ||
    actor.fullName?.trim() ||
    actor.slackUserName?.trim() ||
    actor.slackUserId?.trim() ||
    "Unknown"
  );
}

function emptyActor(actor: ActorIdentity): LocationActorSummaryReport {
  return {
    ...emptyMetrics(),
    actor,
    label: actorLabel(actor),
  };
}

function topLevelWhere() {
  return isNull(juniorConversations.parentConversationId);
}

function publicLocationWhere(destinationId: string) {
  return and(
    topLevelWhere(),
    eq(juniorDestinations.id, destinationId),
    eq(juniorDestinations.visibility, "public"),
  );
}

function locationColumns() {
  return {
    destinationDisplayName: juniorDestinations.displayName,
    destinationId: juniorDestinations.id,
    destinationKind: juniorDestinations.kind,
    destinationProvider: juniorDestinations.provider,
    destinationProviderId: juniorDestinations.providerDestinationId,
    destinationVisibility: juniorDestinations.visibility,
  };
}

function locationGroupBy() {
  return [
    juniorDestinations.displayName,
    juniorDestinations.id,
    juniorDestinations.kind,
    juniorDestinations.provider,
    juniorDestinations.providerDestinationId,
    juniorDestinations.visibility,
  ] as const;
}

type LocationAggregateRow = AggregateRow & {
  destinationDisplayName: string | null;
  destinationId: string | null;
  destinationKind: (typeof juniorDestinations.$inferSelect)["kind"] | null;
  destinationProvider: string | null;
  destinationProviderId: string | null;
  destinationVisibility:
    | (typeof juniorDestinations.$inferSelect)["visibility"]
    | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

/** Admit only complete persisted-public destinations as named locations. */
function locationFromAggregate(
  row: LocationAggregateRow,
): LocationSummaryReport | undefined {
  if (
    row.destinationVisibility !== "public" ||
    !row.destinationId ||
    !row.destinationProvider ||
    !row.destinationProviderId ||
    !row.destinationKind
  ) {
    return undefined;
  }
  const location: LocationSummaryReport = {
    ...emptyMetrics(),
    firstSeenAt: row.firstSeenAt.toISOString(),
    id: row.destinationId,
    kind: row.destinationKind,
    label: publicLabel({
      displayName: row.destinationDisplayName,
      providerDestinationId: row.destinationProviderId,
    }),
    lastSeenAt: row.lastSeenAt.toISOString(),
    provider: row.destinationProvider,
    providerDestinationId: row.destinationProviderId,
    visibility: "public",
  };
  addMetrics(location, row);
  return location;
}

async function directoryRows(db: JuniorDatabase) {
  return db
    .select({
      ...locationColumns(),
      ...treeAggregateColumns,
      ...conversationRangeColumns(),
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
    .where(topLevelWhere())
    .groupBy(...locationGroupBy());
}

async function directoryActivityRows(
  db: JuniorDatabase,
  start: Date,
  hourStart: Date,
) {
  const day = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  const hour = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24'
  )`;
  const select = {
    conversations: sql<number>`COUNT(*)::integer`,
    visibility: juniorDestinations.visibility,
  };
  const [dayRows, hourRows] = await Promise.all([
    db
      .select({ ...select, date: day })
      .from(juniorConversations)
      .leftJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .where(
        and(topLevelWhere(), gte(juniorConversations.lastActivityAt, start)),
      )
      .groupBy(day, juniorDestinations.visibility),
    db
      .select({ ...select, date: hour })
      .from(juniorConversations)
      .leftJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .where(
        and(
          topLevelWhere(),
          gte(juniorConversations.lastActivityAt, hourStart),
        ),
      )
      .groupBy(hour, juniorDestinations.visibility),
  ]);
  return { dayRows, hourRows };
}

function emptyLocationActivityDay(date: string): LocationActivityDayReport {
  return {
    date,
    privateConversations: 0,
    publicConversations: 0,
  };
}

function accumulateLocationActivity(
  rows: Array<{
    conversations: number;
    date: string;
    visibility: string | null;
  }>,
): Map<string, LocationActivityDayReport> {
  const days = new Map<string, LocationActivityDayReport>();
  for (const row of rows) {
    const day = days.get(row.date) ?? emptyLocationActivityDay(row.date);
    if (row.visibility === "public") {
      day.publicConversations += row.conversations;
    } else {
      day.privateConversations += row.conversations;
    }
    days.set(row.date, day);
  }
  return days;
}

function directoryActivityDays(
  rows: Array<{
    conversations: number;
    date: string;
    visibility: string | null;
  }>,
  nowMs: number,
): LocationActivityDayReport[] {
  return fillUtcDays({
    count: ACTIVITY_DAYS,
    empty: emptyLocationActivityDay,
    nowMs,
    rows: accumulateLocationActivity(rows),
  });
}

function directoryActivityHours(
  rows: Array<{
    conversations: number;
    date: string;
    visibility: string | null;
  }>,
  nowMs: number,
): LocationActivityDayReport[] {
  return fillUtcHours({
    count: WINDOW_SEVEN_DAY_HOURS,
    empty: emptyLocationActivityDay,
    nowMs,
    rows: accumulateLocationActivity(rows),
  });
}

function directoryActivitySixHours(
  rows: Array<{
    conversations: number;
    date: string;
    visibility: string | null;
  }>,
  nowMs: number,
): LocationActivityDayReport[] {
  // hourRows use hour keys; sum into 6-hour buckets for 7d charts.
  const hours = fillUtcHours({
    count: WINDOW_SEVEN_DAY_HOURS,
    empty: emptyLocationActivityDay,
    nowMs,
    rows: accumulateLocationActivity(rows),
  });
  return sumUtcHoursIntoSixHours({
    empty: emptyLocationActivityDay,
    hours,
    nowMs,
  });
}

/** Load public locations plus one complete privacy-safe aggregate for non-public activity. */
export async function readLocationDirectoryFromSql(): Promise<LocationDirectoryReport> {
  const nowMs = Date.now();
  const { end, start } = trailingUtcDayWindow(nowMs, ACTIVITY_DAYS);
  const hourWindow = trailingUtcHourWindow(nowMs, WINDOW_SEVEN_DAY_HOURS);
  const [rows, activity] = await Promise.all([
    directoryRows(getDb()),
    directoryActivityRows(getDb(), start, hourWindow.start),
  ]);
  const locations: LocationSummaryReport[] = [];
  const privateActivity = {
    ...emptyMetrics(),
    label: "Private activity",
  };

  for (const row of rows) {
    const location = locationFromAggregate(row);
    if (location) locations.push(location);
    else addMetrics(privateActivity, row);
  }

  return {
    activityDays: directoryActivityDays(activity.dayRows, nowMs),
    activityHours: directoryActivityHours(activity.hourRows, nowMs),
    activitySixHours: directoryActivitySixHours(activity.hourRows, nowMs),
    generatedAt: new Date(nowMs).toISOString(),
    locations: locations.sort(
      (left, right) =>
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) ||
        right.conversations - left.conversations ||
        left.label.localeCompare(right.label),
    ),
    privateActivity,
    source: "conversation_index",
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}

async function recentLocationRows(db: JuniorDatabase, locationId: string) {
  return db
    .select({
      channelName: juniorConversations.channelName,
      conversationId: juniorConversations.conversationId,
      createdAt: juniorConversations.createdAt,
      destinationId: juniorDestinations.id,
      durationMs: juniorConversations.durationMs,
      email: sql<string | null>`COALESCE(
        ${juniorUsers.primaryEmailNormalized},
        ${juniorIdentities.email}
      )`,
      executionStatus: juniorConversations.executionStatus,
      executionUpdatedAt: juniorConversations.executionUpdatedAt,
      fullName: juniorUsers.displayName,
      handle: juniorIdentities.handle,
      lastActivityAt: juniorConversations.lastActivityAt,
      providerSubjectId: sql<string | null>`CASE
        WHEN ${juniorIdentities.provider} = 'slack'
          THEN ${juniorIdentities.providerSubjectId}
        ELSE NULL
      END`,
      source: juniorConversations.source,
      title: juniorConversations.title,
      updatedAt: juniorConversations.updatedAt,
      usage: juniorConversations.usage,
    })
    .from(juniorConversations)
    .innerJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .leftJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(publicLocationWhere(locationId))
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(RECENT_LIMIT);
}

/** Load one public location's complete activity while bounding only recent conversations. */
export async function readLocationDetailFromSql(
  locationId: string,
  options: { viewer?: User } = {},
): Promise<LocationDetailReport | undefined> {
  const nowMs = Date.now();
  const { end, start } = trailingUtcDayWindow(nowMs, ACTIVITY_DAYS);
  const hourWindow = trailingUtcHourWindow(nowMs, WINDOW_SEVEN_DAY_HOURS);
  const where = publicLocationWhere(locationId);
  const activityDate = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  const activityHour = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24'
  )`;

  const [locationRows, dayRows, hourRows, actorRows, recentRows] =
    await Promise.all([
    getDb()
      .select({
        ...locationColumns(),
        ...treeAggregateColumns,
        ...conversationRangeColumns(),
      })
      .from(juniorConversations)
      .innerJoin(
        treeConversation,
        eq(
          treeConversation.rootConversationId,
          juniorConversations.conversationId,
        ),
      )
      .innerJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .where(where)
      .groupBy(...locationGroupBy()),
    getDb()
      .select({
        date: activityDate,
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
      .innerJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .where(and(where, gte(juniorConversations.lastActivityAt, start)))
      .groupBy(activityDate),
    getDb()
      .select({
        date: activityHour,
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
      .innerJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .where(
        and(where, gte(juniorConversations.lastActivityAt, hourWindow.start)),
      )
      .groupBy(activityHour),
    getDb()
      .select({
        actorIdentityId: juniorConversations.actorIdentityId,
        email: juniorUsers.primaryEmailNormalized,
        fullName: juniorUsers.displayName,
        handle: juniorIdentities.handle,
        identityEmail: juniorIdentities.email,
        identityProvider: juniorIdentities.provider,
        providerSubjectId: juniorIdentities.providerSubjectId,
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
      .innerJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .leftJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(where)
      .groupBy(
        juniorConversations.actorIdentityId,
        juniorUsers.primaryEmailNormalized,
        juniorUsers.displayName,
        juniorIdentities.handle,
        juniorIdentities.email,
        juniorIdentities.provider,
        juniorIdentities.providerSubjectId,
      ),
    recentLocationRows(getDb(), locationId),
  ]);

  const locationRow = locationRows[0];
  const location = locationRow ? locationFromAggregate(locationRow) : undefined;
  if (!location) return undefined;

  const days = new Map<string, DailyConversationActivity>();
  for (const row of dayRows) {
    days.set(row.date, {
      active: row.active,
      conversations: row.conversations,
      date: row.date,
      durationMs: row.durationMs,
      failed: row.failed,
      ...(row.tokens !== null ? { tokens: row.tokens } : undefined),
    });
  }
  const hours = new Map<string, DailyConversationActivity>();
  for (const row of hourRows) {
    hours.set(row.date, {
      active: row.active,
      conversations: row.conversations,
      date: row.date,
      durationMs: row.durationMs,
      failed: row.failed,
      ...(row.tokens !== null ? { tokens: row.tokens } : undefined),
    });
  }
  const actors: LocationActorSummaryReport[] = [];
  for (const row of actorRows) {
    if (!row.actorIdentityId) continue;
    const actor: ActorIdentity = {
      ...((row.email ?? row.identityEmail)
        ? { email: row.email ?? row.identityEmail ?? undefined }
        : undefined),
      ...(row.fullName ? { fullName: row.fullName } : undefined),
      ...(row.identityProvider === "slack" && row.providerSubjectId
        ? { slackUserId: row.providerSubjectId }
        : undefined),
      ...(row.handle ? { slackUserName: row.handle } : undefined),
    };
    if (!actor.email && !actor.slackUserId) continue;
    const item = emptyActor(actor);
    addMetrics(item, row);
    actors.push(item);
  }

  const activity = activityDays(days, nowMs, ACTIVITY_DAYS);
  const hourlyActivity = activityHours(hours, nowMs);
  const recentConversationIds = recentRows.map((row) => row.conversationId);
  const [accessByConversation, metricsByRoot] = await Promise.all([
    readConversationAccessFromSql(
      getDb(),
      recentConversationIds,
      options.viewer,
    ),
    readRootConversationMetricsFromSql(getDb(), recentConversationIds),
  ]);
  return {
    ...location,
    activityDays: activity,
    activityHours: hourlyActivity,
    activitySixHours: activitySixHours(hourlyActivity, nowMs),
    actors: actors.sort(
      (left, right) =>
        right.conversations - left.conversations ||
        left.label.localeCompare(right.label),
    ),
    generatedAt: new Date(nowMs).toISOString(),
    recentConversations: recentRows.map((row) =>
      summaryFromRow(row, {
        access: accessByConversation.get(row.conversationId),
        metrics: metricsByRoot.get(row.conversationId),
      }),
    ),
    source: "conversation_index",
    windowEnd: end.toISOString(),
    windowStart: activity[0]
      ? `${activity[0].date}T00:00:00.000Z`
      : end.toISOString(),
  };
}
