import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
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
} from "./shared";

const SEVEN_DAY_OFFSET = 6;
const THIRTY_DAY_OFFSET = 29;
// Defaults until caps are configurable. The dashboard only shows them.
const PERSONAL_SPEND_SOFT_CAPS = {
  monthlySoftCapUsd: 2000,
  weeklySoftCapUsd: 500,
} as const;

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

/** Match the viewer's own Turn cost rows in the spend window. */
function viewerWindowWhere(email: string, nowMs: number) {
  const normalizedEmail = normalizeEmail(email);
  const { end, thirtyDayStart } = spendWindow(nowMs);
  return normalizedEmail
    ? and(
        verifiedActorWhere(normalizedEmail),
        eq(juniorConversationMetrics.metric, "cost_usd"),
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
    .select({ costUsd: turnMetricColumns.costUsd, date })
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
  // Rounding drops float noise from the order in which rows are summed.
  return db
    .select({
      version: sql<string>`concat_ws(':',
        ${thirtyDayStart.toISOString().slice(0, 10)}::text,
        round(sum(${juniorConversationMetrics.value})::numeric, 9),
        round((sum(${juniorConversationMetrics.value}) filter (
          where ${juniorConversationMetrics.occurredAt} >= ${sevenDayStart}
        ))::numeric, 9)
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
  const { end, sevenDayStart, thirtyDayStart } = spendWindow(nowMs);
  const rows = await personalSpendDaysQuery(email, nowMs);

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
    ...PERSONAL_SPEND_SOFT_CAPS,
    sevenDaysUsd,
    source: "conversation_index",
    thirtyDaysUsd,
    windowEnd: end.toISOString(),
    windowStart: thirtyDayStart.toISOString(),
  };
}
