import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { microUsdToUsd } from "@/db/micro-usd";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationMetrics,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import type { PersonalSpendReport } from "../schema/person";
import {
  normalizeEmail,
  turnMetricColumns,
  verifiedActorWhere,
} from "./person-report";

const SEVEN_DAY_OFFSET = 6;
const THIRTY_DAY_OFFSET = 29;

function spendWindow(nowMs: number) {
  const end = new Date(nowMs);
  const currentDay = new Date(end);
  currentDay.setUTCHours(0, 0, 0, 0);
  const sevenDayStart = new Date(currentDay);
  sevenDayStart.setUTCDate(sevenDayStart.getUTCDate() - SEVEN_DAY_OFFSET);
  const thirtyDayStart = new Date(currentDay);
  thirtyDayStart.setUTCDate(thirtyDayStart.getUTCDate() - THIRTY_DAY_OFFSET);
  return { currentDay, end, sevenDayStart, thirtyDayStart };
}

/** Match the viewer's own Turn cost rows in the spend window. */
function viewerWindowWhere(email: string, nowMs: number) {
  const normalizedEmail = normalizeEmail(email);
  const { end, thirtyDayStart } = spendWindow(nowMs);
  return normalizedEmail
    ? and(
        verifiedActorWhere(normalizedEmail),
        eq(juniorConversationMetrics.metric, "cost_micro_usd"),
        gte(juniorConversationMetrics.occurredAt, thirtyDayStart),
        lte(juniorConversationMetrics.occurredAt, end),
      )
    : sql`false`;
}

/** Return a query for one viewer's model spend for each UTC day in the window. */
function personalSpendDaysQuery(email: string, nowMs: number) {
  const date = sql<string>`TO_CHAR(
    ${juniorConversationMetrics.occurredAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD'
  )`;
  return getDb()
    .select({ costMicroUsd: turnMetricColumns.costMicroUsd, date })
    .from(juniorConversationMetrics)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversationMetrics.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(viewerWindowWhere(email, nowMs))
    .groupBy(date);
}

/**
 * Return a query for a change marker of one viewer's spend window.
 *
 * It reads the same Turn cost rows as the spend read and holds the two
 * totals that the read shows. A checkpoint rewrites every metric row of its
 * Turn, so a Turn that runs longer or uses more tokens without more cost
 * does not move it. The window start moves it at UTC midnight.
 */
export function personalSpendVersionQuery(
  db: JuniorDatabase,
  email: string,
  nowMs: number,
) {
  const { sevenDayStart, thirtyDayStart } = spendWindow(nowMs);
  // Micro-USD sums are exact, so row order does not change the marker.
  return db
    .select({
      version: sql<string>`concat_ws(':',
        ${thirtyDayStart.toISOString().slice(0, 10)}::text,
        sum(${juniorConversationMetrics.value})::bigint,
        (sum(${juniorConversationMetrics.value}) filter (
          where ${juniorConversationMetrics.occurredAt} >= ${sevenDayStart}
        ))::bigint
      )`,
    })
    .from(juniorConversationMetrics)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversationMetrics.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(viewerWindowWhere(email, nowMs));
}

/** Read one viewer's rolling model spend with one bounded aggregate query. */
export async function readPersonalSpendFromSql(
  email: string,
  nowMs = Date.now(),
): Promise<PersonalSpendReport> {
  const { currentDay, sevenDayStart, thirtyDayStart } = spendWindow(nowMs);
  const rows = await personalSpendDaysQuery(email, nowMs);

  const sevenDayStartDate = sevenDayStart.toISOString().slice(0, 10);
  let sevenDaysMicroUsd = 0;
  let thirtyDaysMicroUsd = 0;
  for (const row of rows) {
    if (row.costMicroUsd === null) continue;
    thirtyDaysMicroUsd += row.costMicroUsd;
    if (row.date >= sevenDayStartDate) {
      sevenDaysMicroUsd += row.costMicroUsd;
    }
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    sevenDaysUsd: microUsdToUsd(sevenDaysMicroUsd),
    source: "conversation_index",
    thirtyDaysUsd: microUsdToUsd(thirtyDaysMicroUsd),
    // The window's last UTC day, as other day windows report it. The read
    // time would change the body, and its revalidation token, on each read.
    windowEnd: currentDay.toISOString(),
    windowStart: thirtyDayStart.toISOString(),
  };
}
