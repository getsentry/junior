import { sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { usdToMicroUsd } from "@/db/micro-usd";
import { juniorGuardianReviewHours } from "@/db/schema";

const HOUR_MS = 60 * 60 * 1000;

type GuardianReviewHour = typeof juniorGuardianReviewHours.$inferInsert;

/**
 * Add Guardian reviews to the counts of their UTC hour and decision. Call it
 * in the transaction that appends the review events, so a count matches the
 * events.
 */
export async function addGuardianReviewHours(
  executor: JuniorSqlDatabase,
  reviews: ReadonlyArray<{
    costUsd?: number | undefined;
    createdAtMs: number;
    decision: string;
  }>,
): Promise<void> {
  const hours = new Map<string, GuardianReviewHour>();
  for (const review of reviews) {
    const hourMs = Math.floor(review.createdAtMs / HOUR_MS) * HOUR_MS;
    const key = `${hourMs}:${review.decision}`;
    const costMicroUsd =
      review.costUsd === undefined ? null : usdToMicroUsd(review.costUsd);
    const hour = hours.get(key);
    if (!hour) {
      hours.set(key, {
        costMicroUsd,
        decision: review.decision,
        hour: new Date(hourMs),
        reviews: 1,
      });
      continue;
    }
    hour.reviews += 1;
    if (costMicroUsd !== null)
      hour.costMicroUsd = (hour.costMicroUsd ?? 0) + costMicroUsd;
  }
  if (hours.size === 0) return;
  const table = juniorGuardianReviewHours;
  await executor
    .db()
    .insert(table)
    // One key order, so two appends cannot lock the same rows in turn.
    .values(
      [...hours.entries()]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([, hour]) => hour),
    )
    .onConflictDoUpdate({
      target: [table.hour, table.decision],
      set: {
        reviews: sql`${table.reviews} + excluded.${sql.identifier(table.reviews.name)}`,
        // A null cost on one side keeps the cost of the other side.
        costMicroUsd: sql`coalesce(
          ${table.costMicroUsd} + excluded.${sql.identifier(table.costMicroUsd.name)},
          ${table.costMicroUsd},
          excluded.${sql.identifier(table.costMicroUsd.name)}
        )`,
      },
    });
}
