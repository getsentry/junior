import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { conversationUsageCostExpr } from "../conversations/aggregate";
import type { PersonalSpendReport } from "../schema/person";
import {
  normalizeEmail,
  peopleTreeAggregateColumns,
  peopleTreeConversation,
  peopleTreeMetricsJoin,
  verifiedActorWhere,
} from "./shared";

const SEVEN_DAY_OFFSET = 6;
const THIRTY_DAY_OFFSET = 29;

function addUsd(current: number, next: number): number {
  return Math.round((current + next) * 1e12) / 1e12;
}

function spendWindow(nowMs: number) {
  const end = new Date(nowMs);
  const currentDay = new Date(end);
  currentDay.setUTCHours(0, 0, 0, 0);
  const sevenDayStart = new Date(currentDay);
  sevenDayStart.setUTCDate(sevenDayStart.getUTCDate() - SEVEN_DAY_OFFSET);
  const thirtyDayStart = new Date(currentDay);
  thirtyDayStart.setUTCDate(thirtyDayStart.getUTCDate() - THIRTY_DAY_OFFSET);
  return { end, sevenDayStart, thirtyDayStart };
}

/** Match the viewer's own Conversations with activity in the spend window. */
function viewerWindowWhere(email: string, nowMs: number) {
  const normalizedEmail = normalizeEmail(email);
  const { end, thirtyDayStart } = spendWindow(nowMs);
  return normalizedEmail
    ? and(
        verifiedActorWhere(normalizedEmail),
        gte(juniorConversations.lastActivityAt, thirtyDayStart),
        lte(juniorConversations.lastActivityAt, end),
      )
    : sql`false`;
}

/** Return a query for one viewer's model spend for each UTC day in the window. */
function personalSpendDaysQuery(
  db: JuniorDatabase,
  email: string,
  nowMs: number,
) {
  const activityDate = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  return db
    .select({
      costUsd: peopleTreeAggregateColumns.costUsd,
      date: activityDate,
    })
    .from(juniorConversations)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .leftJoin(peopleTreeConversation, peopleTreeMetricsJoin())
    .where(viewerWindowWhere(email, nowMs))
    .groupBy(activityDate);
}

/**
 * Return a query for a change marker of one viewer's spend window.
 *
 * It reads only the viewer's own rows, without the tree join of the spend
 * read, so it costs about as much as a count. It sums each row's own cost
 * and the UTC day of its last activity, so a recorded cost, or a
 * Conversation that moves to a new day, moves it. Other writes do not. A
 * Task that another person's Turn started under the viewer's root is not
 * the viewer's row, so its cost shows on the next spend read: a page load,
 * a tab focus, or the viewer's next own cost. The window start moves it at
 * UTC midnight.
 */
export function personalSpendVersionQuery(
  db: JuniorDatabase,
  email: string,
  nowMs: number,
) {
  const { thirtyDayStart } = spendWindow(nowMs);
  return db
    .select({
      version: sql<string>`concat_ws(':',
        ${thirtyDayStart.toISOString().slice(0, 10)}::text,
        count(*),
        sum(${conversationUsageCostExpr(juniorConversations.usage)}),
        sum(extract(epoch from date_trunc('day', ${juniorConversations.lastActivityAt} at time zone 'UTC')))
      )`,
    })
    .from(juniorConversations)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(viewerWindowWhere(email, nowMs));
}

/** Read one viewer's rolling model spend with one bounded aggregate query. */
export async function readPersonalSpendFromSql(
  email: string,
  nowMs = Date.now(),
): Promise<PersonalSpendReport> {
  const { end, sevenDayStart, thirtyDayStart } = spendWindow(nowMs);
  const rows = await personalSpendDaysQuery(getDb(), email, nowMs);

  const sevenDayStartDate = sevenDayStart.toISOString().slice(0, 10);
  let sevenDaysUsd = 0;
  let thirtyDaysUsd = 0;
  for (const row of rows) {
    if (row.costUsd === null) continue;
    thirtyDaysUsd = addUsd(thirtyDaysUsd, row.costUsd);
    if (row.date >= sevenDayStartDate) {
      sevenDaysUsd = addUsd(sevenDaysUsd, row.costUsd);
    }
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    sevenDaysUsd,
    source: "conversation_index",
    thirtyDaysUsd,
    windowEnd: end.toISOString(),
    windowStart: thirtyDayStart.toISOString(),
  };
}
