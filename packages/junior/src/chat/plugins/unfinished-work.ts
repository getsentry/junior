import { getDb } from "@/chat/db";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { createPluginLogger } from "@/chat/plugins/logging";

/** Return candidate conversations that have unfinished plugin work. */
export async function listUnfinishedWork(
  conversationIds: string[],
): Promise<string[]> {
  if (conversationIds.length === 0) return [];
  const candidates = new Set(conversationIds);
  const unfinished = new Set<string>();
  for (const plugin of getPlugins()) {
    const hook = plugin.hooks?.unfinishedWork;
    if (!hook) continue;
    const result = await hook({
      conversationIds,
      db: getDb(),
      log: createPluginLogger(plugin.manifest.name),
      plugin: { name: plugin.manifest.name },
    });
    for (const conversationId of result.conversationIds) {
      if (candidates.has(conversationId)) unfinished.add(conversationId);
    }
  }
  return conversationIds.filter((conversationId) =>
    unfinished.has(conversationId),
  );
}
