import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import {
  conversationActiveDaysColumn,
  conversationRangeColumns,
} from "../conversations/aggregate";
import type {
  ActorDirectoryReport,
  ActorIdentity,
  ActorSummaryReport,
  PeopleActivityDayReport,
} from "../schema/person";
import {
  peopleTreeAggregateColumns,
  peopleTreeConversation,
  peopleTreeMetricsJoin,
  verifiedActorWhere,
} from "./shared";
import {
  fillUtcDays,
  fillUtcHours,
  trailingUtcDayWindow,
  trailingUtcHourWindow,
} from "../reporting-window";

const DIRECTORY_ACTIVITY_DAYS = 90;

function activityWindow(nowMs: number) {
  return trailingUtcDayWindow(nowMs, DIRECTORY_ACTIVITY_DAYS);
}

function emptyDirectoryDay(date: string): PeopleActivityDayReport {
  return { activePeople: 0, conversations: 0, date };
}

function directoryActivityDays(
  rows: PeopleActivityDayReport[],
  nowMs: number,
): PeopleActivityDayReport[] {
  return fillUtcDays({
    count: DIRECTORY_ACTIVITY_DAYS,
    empty: emptyDirectoryDay,
    nowMs,
    rows: new Map(rows.map((row) => [row.date, row])),
  });
}

function directoryActivityHours(
  rows: PeopleActivityDayReport[],
  nowMs: number,
): PeopleActivityDayReport[] {
  return fillUtcHours({
    empty: emptyDirectoryDay,
    nowMs,
    rows: new Map(rows.map((row) => [row.date, row])),
  });
}

/** Load the complete People directory with grouping and metrics owned by SQL. */
export async function readPeopleListFromSql(): Promise<ActorDirectoryReport> {
  const nowMs = Date.now();
  const { end, start } = activityWindow(nowMs);
  const activityDate = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  const activityHour = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24'
  )`;
  const hourWindow = trailingUtcHourWindow(nowMs);
  const [rows, activityRows, activityHourRows] = await Promise.all([
    getDb()
      .select({
        email: juniorUsers.primaryEmailNormalized,
        fullName: juniorUsers.displayName,
        slackUserId: sql<
          string | null
        >`MAX(${juniorIdentities.providerSubjectId})`,
        slackUserName: sql<string | null>`MAX(${juniorIdentities.handle})`,
        activeDays: conversationActiveDaysColumn(),
        ...peopleTreeAggregateColumns,
        ...conversationRangeColumns(),
      })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .leftJoin(peopleTreeConversation, peopleTreeMetricsJoin())
      .where(verifiedActorWhere())
      .groupBy(juniorUsers.primaryEmailNormalized, juniorUsers.displayName),
    getDb()
      .select({
        activePeople: sql<number>`COUNT(DISTINCT ${juniorUsers.id})::int`,
        conversations: sql<number>`COUNT(*)::int`,
        date: activityDate,
      })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(
        and(
          verifiedActorWhere(),
          gte(juniorConversations.lastActivityAt, start),
        ),
      )
      .groupBy(activityDate),
    getDb()
      .select({
        activePeople: sql<number>`COUNT(DISTINCT ${juniorUsers.id})::int`,
        conversations: sql<number>`COUNT(*)::int`,
        date: activityHour,
      })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(
        and(
          verifiedActorWhere(),
          gte(juniorConversations.lastActivityAt, hourWindow.start),
        ),
      )
      .groupBy(activityHour),
  ]);

  const people: ActorSummaryReport[] = rows.map((row) => {
    const actor: ActorIdentity & { email: string } = {
      email: row.email,
      ...(row.fullName ? { fullName: row.fullName } : undefined),
      ...(row.slackUserId ? { slackUserId: row.slackUserId } : undefined),
      ...(row.slackUserName ? { slackUserName: row.slackUserName } : undefined),
    };
    return {
      active: row.active,
      activeDays: row.activeDays,
      conversations: row.conversations,
      durationMs: row.durationMs,
      failed: row.failed,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      actor,
      ...(row.tokens !== null ? { tokens: row.tokens } : undefined),
    };
  });

  return {
    activityDays: directoryActivityDays(activityRows, nowMs),
    activityHours: directoryActivityHours(activityHourRows, nowMs),
    generatedAt: new Date(nowMs).toISOString(),
    people: people.sort(
      (left, right) =>
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) ||
        right.conversations - left.conversations ||
        left.actor.email.localeCompare(right.actor.email),
    ),
    source: "conversation_index",
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}
