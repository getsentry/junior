import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationMetrics,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { verifiedActorWhere } from "../people/person-report";

const metrics = juniorConversationMetrics;

export interface PersonSpendDayRow {
  date: string;
  medianPersonCostMicroUsd: number | null;
  people: number;
  personCostMicroUsd: number;
  unattributedCostMicroUsd: number;
}

/**
 * Read model spend per UTC day, split between verified people and Turns with
 * no verified person, with the count of active people and the median spend
 * of one person. A person is one Junior user, so their Slack and web
 * Identities count once. Every Run writes a `duration_ms` row, so a person
 * with a Turn but no cost row counts with zero spend.
 *
 * Metric rows are grouped by day and Identity before any join, so the joins
 * read one row per Identity and day.
 */
export async function readPersonSpendDays(
  db: JuniorDatabase,
  options: { start: Date; end: Date },
): Promise<PersonSpendDayRow[]> {
  // Matches the `junior_conversation_metrics_utc_day_actor` statistics, so
  // the planner knows how few day and Identity groups there are and hashes
  // them instead of sorting every row. Format the day only after grouping.
  const day = sql<Date>`date_trunc('day', ${metrics.occurredAt} at time zone 'UTC')`;
  const identityDays = db
    .select({
      date: day.as("identity_day_date"),
      identityId: sql<string | null>`${metrics.actorIdentityId}`.as(
        "identity_day_identity_id",
      ),
      costMicroUsd: sql<number>`coalesce(sum(${metrics.value}) FILTER (
        WHERE ${metrics.metric} = 'cost_micro_usd'
      ), 0)`.as("identity_day_micro_usd"),
    })
    .from(metrics)
    .where(
      and(
        inArray(metrics.metric, ["duration_ms", "cost_micro_usd"]),
        gte(metrics.occurredAt, options.start),
        lte(metrics.occurredAt, options.end),
      ),
    )
    .groupBy(day, metrics.actorIdentityId)
    .as("person_identity_days");
  // Null for a Turn with no Identity, or an Identity that is not a verified
  // person, so those Turns group into one unattributed row per day.
  const identityPeople = db
    .select({
      date: sql<Date>`${identityDays.date}`.as("identity_person_date"),
      userId: sql<
        string | null
      >`CASE WHEN ${verifiedActorWhere()} THEN ${juniorUsers.id} END`.as(
        "identity_person_user_id",
      ),
      costMicroUsd: sql<number>`${identityDays.costMicroUsd}`.as(
        "identity_person_micro_usd",
      ),
    })
    .from(identityDays)
    .leftJoin(
      juniorIdentities,
      eq(juniorIdentities.id, identityDays.identityId),
    )
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .as("person_identity_people");
  const personDays = db
    .select({
      date: sql<Date>`${identityPeople.date}`.as("person_day_date"),
      userId: sql<string | null>`${identityPeople.userId}`.as(
        "person_day_user_id",
      ),
      costMicroUsd: sql<number>`sum(${identityPeople.costMicroUsd})`.as(
        "person_day_micro_usd",
      ),
    })
    .from(identityPeople)
    .groupBy(identityPeople.date, identityPeople.userId)
    .as("person_days");
  const person = sql`${personDays.userId} IS NOT NULL`;
  return await db
    .select({
      date: sql<string>`to_char(${personDays.date}, 'YYYY-MM-DD')`,
      medianPersonCostMicroUsd: sql<
        number | null
      >`(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${personDays.costMicroUsd}) FILTER (WHERE ${person}))::double precision`,
      people: sql<number>`(count(*) FILTER (WHERE ${person}))::integer`,
      personCostMicroUsd: sql<number>`coalesce(sum(${personDays.costMicroUsd}) FILTER (WHERE ${person}), 0)::double precision`,
      unattributedCostMicroUsd: sql<number>`coalesce(sum(${personDays.costMicroUsd}) FILTER (WHERE NOT ${person}), 0)::double precision`,
    })
    .from(personDays)
    .groupBy(personDays.date);
}
