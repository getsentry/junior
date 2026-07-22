import { and, inArray, isNotNull } from "drizzle-orm";
import { addAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";

/** Aggregate persisted usage for selected root conversation trees. */
export async function readRootConversationUsageFromSql(
  db: JuniorDatabase,
  rootConversationIds: string[],
): Promise<Map<string, AgentTurnUsage>> {
  if (rootConversationIds.length === 0) return new Map();

  const rows = await db
    .select({
      rootConversationId: juniorConversations.rootConversationId,
      usage: juniorConversations.usage,
    })
    .from(juniorConversations)
    .where(
      and(
        inArray(juniorConversations.rootConversationId, rootConversationIds),
        isNotNull(juniorConversations.usage),
      ),
    );
  const usageByRoot = new Map<string, AgentTurnUsage>();
  for (const row of rows) {
    if (!row.rootConversationId || !row.usage) continue;
    const usage = addAgentTurnUsage(
      usageByRoot.get(row.rootConversationId),
      row.usage,
    );
    if (usage) usageByRoot.set(row.rootConversationId, usage);
  }
  return usageByRoot;
}
