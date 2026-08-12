import { getDb } from "@/chat/db";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { createPluginLogger } from "@/chat/plugins/logging";
import { logWarn } from "@/chat/logging";

export type ConversationWork = {
  assignedIds: string[];
  unfinishedIds: string[];
};

/** Return assigned and unfinished plugin work for the candidate conversations. */
export async function listConversationWork(
  conversationIds: string[],
): Promise<ConversationWork> {
  if (conversationIds.length === 0) {
    return { assignedIds: [], unfinishedIds: [] };
  }
  const candidates = new Set(conversationIds);
  const assigned = new Set<string>();
  const unfinished = new Set<string>();
  for (const plugin of getPlugins()) {
    const hook = plugin.hooks?.unfinishedWork;
    if (!hook) continue;
    try {
      const result = await hook({
        conversationIds,
        db: getDb(),
        log: createPluginLogger(plugin.manifest.name),
        plugin: { name: plugin.manifest.name },
      });
      for (const conversationId of result.conversationIds) {
        if (!candidates.has(conversationId)) continue;
        unfinished.add(conversationId);
        assigned.add(conversationId);
      }
      for (const conversationId of result.assignedConversationIds ?? []) {
        if (candidates.has(conversationId)) assigned.add(conversationId);
      }
    } catch (error) {
      // Fail open: a broken plugin must not invent assigned or unfinished work
      // and demote recent conversations out of Priority.
      logWarn("plugin.unfinished_work.hook.failed", {
        "app.plugin.name": plugin.manifest.name,
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    assignedIds: conversationIds.filter((conversationId) =>
      assigned.has(conversationId),
    ),
    unfinishedIds: conversationIds.filter((conversationId) =>
      unfinished.has(conversationId),
    ),
  };
}

/** Return candidate conversations that have unfinished plugin work. */
export async function listUnfinishedWork(
  conversationIds: string[],
): Promise<string[]> {
  return (await listConversationWork(conversationIds)).unfinishedIds;
}
