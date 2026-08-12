import { getDb } from "@/chat/db";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { createPluginLogger } from "@/chat/plugins/logging";
import { logWarn } from "@/chat/logging";

export type ConversationWork = {
  assignedIds: string[];
  finishedAtById: Record<string, string>;
  unfinishedIds: string[];
};

/** Return assigned and unfinished plugin work for the candidate conversations. */
export async function listConversationWork(
  conversationIds: string[],
): Promise<ConversationWork> {
  if (conversationIds.length === 0) {
    return { assignedIds: [], finishedAtById: {}, unfinishedIds: [] };
  }
  const candidates = new Set(conversationIds);
  const assigned = new Set<string>();
  const finishedAtById = new Map<string, string>();
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
      for (const [conversationId, finishedAt] of Object.entries(
        result.finishedWorkAtByConversationId ?? {},
      )) {
        if (!candidates.has(conversationId)) continue;
        const time = Date.parse(finishedAt);
        if (!Number.isFinite(time)) continue;
        const current = finishedAtById.get(conversationId);
        if (!current || time > Date.parse(current)) {
          finishedAtById.set(conversationId, finishedAt);
        }
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
    finishedAtById: Object.fromEntries(
      conversationIds.flatMap((conversationId) => {
        const finishedAt = finishedAtById.get(conversationId);
        return finishedAt ? [[conversationId, finishedAt]] : [];
      }),
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
