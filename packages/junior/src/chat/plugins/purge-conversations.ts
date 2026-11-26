import { getRegistrations } from "@/chat/plugins/agent-hooks";
import { createPluginLogger } from "@/chat/plugins/logging";

/**
 * Run the `purgeConversations` hooks in the purge transaction `db`, one
 * plugin after another. A hook that fails fails the purge, so no plugin
 * keeps content of a purged transcript.
 */
export async function purgePluginConversationContent(
  db: unknown,
  conversationIds: string[],
): Promise<void> {
  for (const plugin of getRegistrations()) {
    const hook = plugin.hooks?.purgeConversations;
    if (!hook) continue;
    const name = plugin.manifest.name;
    // oxlint-disable-next-line no-await-in-loop -- The hooks share one purge transaction, which runs one query at a time.
    await hook({
      conversationIds,
      db,
      log: createPluginLogger(name),
      plugin: { name },
    });
  }
}
