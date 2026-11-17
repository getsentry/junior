import { sql, type SQL } from "drizzle-orm";
import { conversationUsageCostExpr } from "@/api/conversations/aggregate";
import { juniorConversations } from "@/db/schema";

/**
 * SQL that reads the cost of one Conversation, for the `cost_usd` of its run.
 * Set it in each run write that links a run to its Conversation, because the
 * Conversation can record usage before its run row exists.
 */
export function conversationCostOf(
  conversationId: SQL | string,
): SQL<number | null> {
  return sql`(select ${conversationUsageCostExpr(juniorConversations.usage)} from ${juniorConversations} where ${juniorConversations.conversationId} = ${conversationId})`;
}
