import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { logException, logInfo } from "@/chat/logging";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { createPluginLogger } from "@/chat/plugins/logging";
import { juniorConversations } from "@/db/schema";

const INACTIVE_CONVERSATION_AGE_MS = 60 * 60 * 1000;
const INACTIVE_CONVERSATION_LIMIT = 100;

/** Archive a bounded batch of inactive conversations with no unfinished plugin work. */
export async function archiveInactiveConversations(
  nowMs: number,
): Promise<number> {
  const db = getDb();
  const cutoff = new Date(nowMs - INACTIVE_CONVERSATION_AGE_MS);
  const candidates = await db
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        isNull(juniorConversations.archivedAt),
        isNull(juniorConversations.parentConversationId),
        eq(juniorConversations.executionStatus, "idle"),
        lt(juniorConversations.lastActivityAt, cutoff),
      ),
    )
    .orderBy(asc(juniorConversations.lastActivityAt))
    .limit(INACTIVE_CONVERSATION_LIMIT);
  if (candidates.length === 0) return 0;

  const conversationIds = candidates.map(
    ({ conversationId }) => conversationId,
  );
  const unfinished = new Set<string>();
  for (const plugin of getPlugins()) {
    const hook = plugin.hooks?.unfinishedWork;
    if (!hook) continue;
    try {
      const result = await hook({
        conversationIds,
        db,
        log: createPluginLogger(plugin.manifest.name),
        plugin: { name: plugin.manifest.name },
      });
      const candidatesSet = new Set(conversationIds);
      for (const conversationId of result.conversationIds) {
        if (candidatesSet.has(conversationId)) unfinished.add(conversationId);
      }
    } catch (error) {
      logException(error, "plugin.unfinished_work.failed", {
        "app.plugin.name": plugin.manifest.name,
      });
      for (const conversationId of conversationIds)
        unfinished.add(conversationId);
    }
  }

  const finished = conversationIds.filter(
    (conversationId) => !unfinished.has(conversationId),
  );
  if (finished.length === 0) return 0;

  const archived = await db
    .update(juniorConversations)
    .set({ archivedAt: new Date(nowMs) })
    .where(
      and(
        inArray(juniorConversations.conversationId, finished),
        isNull(juniorConversations.archivedAt),
        isNull(juniorConversations.parentConversationId),
        eq(juniorConversations.executionStatus, "idle"),
        lt(juniorConversations.lastActivityAt, cutoff),
      ),
    )
    .returning({ conversationId: juniorConversations.conversationId });
  if (archived.length > 0) {
    logInfo("conversation.inactive.archived", {
      "app.conversation.count": archived.length,
    });
  }
  return archived.length;
}
