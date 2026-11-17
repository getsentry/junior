import { sql, type SQL } from "drizzle-orm";
import { conversationUsageCostExpr } from "@/api/conversations/aggregate";
import type { JuniorDatabase } from "@/db/db";
import { juniorAutomationRuns } from "@/db/schema/automation-runs";
import { juniorConversations } from "@/db/schema";

/**
 * Copy the cost of each matched run's Conversation to the run, so Automation
 * cost totals read only runs. Call it after each write that changes a
 * Conversation's usage or links a run to its Conversation.
 */
export async function refreshAutomationRunCost(
  db: JuniorDatabase,
  where: SQL,
): Promise<void> {
  await db
    .update(juniorAutomationRuns)
    .set({
      costUsd: sql`(select ${conversationUsageCostExpr(juniorConversations.usage)} from ${juniorConversations} where ${juniorConversations.conversationId} = ${juniorAutomationRuns.conversationId})`,
    })
    .where(where);
}
