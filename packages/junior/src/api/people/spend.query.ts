import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
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

/** Read one viewer's rolling model spend with one bounded aggregate query. */
export async function readPersonalSpendFromSql(
  email: string,
  nowMs = Date.now(),
): Promise<PersonalSpendReport> {
  const normalizedEmail = normalizeEmail(email);
  const { end, sevenDayStart, thirtyDayStart } = spendWindow(nowMs);
  const activityDate = sql<string>`TO_CHAR(
    ${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  const metricsJoin = peopleTreeMetricsJoin();
  const rows = normalizedEmail
    ? await getDb()
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
        .leftJoin(peopleTreeConversation, metricsJoin)
        .where(
          and(
            verifiedActorWhere(normalizedEmail),
            gte(juniorConversations.lastActivityAt, thirtyDayStart),
            lte(juniorConversations.lastActivityAt, end),
          ),
        )
        .groupBy(activityDate)
    : [];

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
