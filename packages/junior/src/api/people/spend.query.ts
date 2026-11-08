import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
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

/** Return a query for one viewer's model spend for each UTC day in the window. */
function personalSpendDaysQuery(
  db: JuniorDatabase,
  email: string,
  nowMs: number,
) {
  const normalizedEmail = normalizeEmail(email);
  const { end, thirtyDayStart } = spendWindow(nowMs);
  const activityDate = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  return db
    .select({
      costUsd: peopleTreeAggregateColumns.costUsd.as("cost_usd"),
      date: activityDate.as("date"),
    })
    .from(juniorConversations)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .leftJoin(peopleTreeConversation, peopleTreeMetricsJoin())
    .where(
      normalizedEmail
        ? and(
            verifiedActorWhere(normalizedEmail),
            gte(juniorConversations.lastActivityAt, thirtyDayStart),
            lte(juniorConversations.lastActivityAt, end),
          )
        : sql`false`,
    )
    .groupBy(activityDate);
}

/**
 * Return a query for a change marker of one viewer's spend window. It holds
 * the spend of each day, so only a change to the shown spend moves it. The
 * window start is part of the marker, so it also changes when the window
 * moves at UTC midnight.
 */
export function personalSpendVersionQuery(
  db: JuniorDatabase,
  email: string,
  nowMs: number,
) {
  const { thirtyDayStart } = spendWindow(nowMs);
  const days = personalSpendDaysQuery(db, email, nowMs).as("spend_days");
  return db
    .select({
      version: sql<string>`concat_ws(':',
        ${thirtyDayStart.toISOString().slice(0, 10)}::text,
        string_agg(concat_ws('=', ${days.date}, ${days.costUsd}), ',' order by ${days.date})
      )`,
    })
    .from(days);
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
