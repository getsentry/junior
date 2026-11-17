import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { conversationUsageCostExpr } from "@/api/conversations/aggregate";
import { juniorConversations } from "@/db/schema";

/**
 * SQL for a Conversation's cost in whole micro-USD, the unit of a run's
 * `cost_micro_usd`. Integer sums are exact and do not depend on row order.
 */
export function costMicroUsdExpr(usage: AnyPgColumn): SQL<number | null> {
  return sql<
    number | null
  >`round(${conversationUsageCostExpr(usage)} * 1000000)::bigint`;
}

/** Convert a sum of `cost_micro_usd` to USD for the API. */
export function microUsdToUsd(microUsd: number): number {
  return microUsd / 1_000_000;
}

/**
 * SQL that reads the cost of one Conversation, for the `cost_micro_usd` of its
 * run. Set it in each run write that links a run to its Conversation, because
 * the Conversation can record usage before its run row exists.
 */
export function conversationCostOf(
  conversationId: SQL | string,
): SQL<number | null> {
  return sql`(select ${costMicroUsdExpr(juniorConversations.usage)} from ${juniorConversations} where ${juniorConversations.conversationId} = ${conversationId})`;
}
