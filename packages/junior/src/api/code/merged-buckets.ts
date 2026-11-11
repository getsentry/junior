import { and, gte, lte, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorCodeChanges } from "@/db/schema";
import { conversationTreeCostExpr } from "./overview";

export interface MergedCodeChangeBucket {
  costUsd: number;
  date: string;
  merged: number;
}

/**
 * Count merged code changes per UTC day or hour, with the summed cost of each
 * change's linked conversation trees. Each change carries its full tree cost,
 * so `costUsd / merged` is the mean cost of one merged change.
 */
export async function readMergedCodeChangeBuckets(
  db: JuniorDatabase,
  options: { bucket: "day" | "hour"; start: Date; end: Date },
): Promise<MergedCodeChangeBucket[]> {
  const changes = juniorCodeChanges;
  const date =
    options.bucket === "day"
      ? sql<string>`to_char(${changes.mergedAt} at time zone 'UTC', 'YYYY-MM-DD')`
      : sql<string>`to_char(${changes.mergedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24')`;
  const cost = conversationTreeCostExpr(sql`${changes.conversationIds}`);
  return await db
    .select({
      costUsd: sql<number>`coalesce(sum(${cost}), 0)::double precision`,
      date,
      merged: sql<number>`count(*)::integer`,
    })
    .from(changes)
    .where(
      and(
        gte(changes.mergedAt, options.start),
        lte(changes.mergedAt, options.end),
      ),
    )
    .groupBy(date);
}
