import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { conversationUsageCostExpr } from "@/api/conversations/aggregate";
import { juniorConversations } from "@/db/schema";
import { usdToMicroUsdSql } from "@/db/micro-usd";

/**
 * SQL for a Conversation's usage cost in whole micro-USD, the unit of a run's
 * `cost_micro_usd`.
 */
export function costMicroUsdExpr(usage: AnyPgColumn): SQL<number | null> {
  return usdToMicroUsdSql(conversationUsageCostExpr(usage));
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
