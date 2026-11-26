import { and, eq, gt, gte, lte, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationMetricDays,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { verifiedActorWhere } from "../people/person-report";

const days = juniorConversationMetricDays;

const utcDay = (at: Date) => at.toISOString().slice(0, 10);

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
 * It reads `junior_conversation_metric_days`, so it reads one row per
 * Identity and day, not one per Turn. It reads whole UTC days: the stats
 * window starts at a UTC midnight and ends now.
 */
export async function readPersonSpendDays(
  db: JuniorDatabase,
  options: { start: Date; end: Date },
): Promise<PersonSpendDayRow[]> {
  // Null for a Turn with no Identity, or an Identity that is not a verified
  // person, so those Turns group into one unattributed row per day.
  const identityPeople = db
    .select({
      date: sql<string>`${days.day}`.as("identity_person_date"),
      userId: sql<
        string | null
      >`CASE WHEN ${verifiedActorWhere()} THEN ${juniorUsers.id} END`.as(
        "identity_person_user_id",
      ),
      // Summed as doubles, like the metric values that it adds up.
      costMicroUsd: sql<number>`${days.costMicroUsd}::double precision`.as(
        "identity_person_micro_usd",
      ),
    })
    .from(days)
    .leftJoin(juniorIdentities, eq(juniorIdentities.id, days.actorIdentityId))
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        gte(days.day, utcDay(options.start)),
        lte(days.day, utcDay(options.end)),
        // A day whose Turns were all deleted keeps a zero row.
        gt(days.metricRows, 0),
      ),
    )
    .as("person_identity_people");
  const personDays = db
    .select({
      date: sql<string>`${identityPeople.date}`.as("person_day_date"),
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
