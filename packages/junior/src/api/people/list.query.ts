import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import {
  conversationActiveDaysColumn,
  conversationAggregateColumns,
  conversationRangeColumns,
} from "../conversations/aggregate";
import type {
  ActorDirectoryReport,
  ActorIdentity,
  ActorSummaryReport,
  PeopleActivityDayReport,
} from "./schema";
import { verifiedActorWhere } from "./shared";

const DIRECTORY_ACTIVITY_DAYS = 90;

function activityWindow(nowMs: number) {
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (DIRECTORY_ACTIVITY_DAYS - 1));
  return { end, start };
}

function directoryActivityDays(
  rows: PeopleActivityDayReport[],
  nowMs: number,
): PeopleActivityDayReport[] {
  const days = new Map(rows.map((row) => [row.date, row]));
  const { end, start } = activityWindow(nowMs);
  const items: PeopleActivityDayReport[] = [];
  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    items.push(days.get(date) ?? { activePeople: 0, conversations: 0, date });
  }
  return items;
}

/** Load the complete People directory with grouping and metrics owned by SQL. */
export async function readPeopleListFromSql(): Promise<ActorDirectoryReport> {
  const nowMs = Date.now();
  const { end, start } = activityWindow(nowMs);
  const activityDate = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  const [rows, activityRows] = await Promise.all([
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
        ...conversationRangeColumns(),
      })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
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
  ]);

  const people: ActorSummaryReport[] = rows.map((row) => {
    const actor: ActorIdentity & { email: string } = {
      email: row.email,
      ...(row.fullName ? { fullName: row.fullName } : {}),
      ...(row.slackUserId ? { slackUserId: row.slackUserId } : {}),
      ...(row.slackUserName ? { slackUserName: row.slackUserName } : {}),
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
      ...(row.tokens !== null ? { tokens: row.tokens } : {}),
    };
  });

  return {
    activityDays: directoryActivityDays(activityRows, nowMs),
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
