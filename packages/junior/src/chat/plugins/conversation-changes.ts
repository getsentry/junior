import {
  MAX_CONVERSATION_CHANGES,
  type ConversationChangeBatch,
  type PluginConversationChanges,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { mapBounded } from "@/chat/fan-out";
import type { ShowInboxItem } from "@/chat/inbox-items/changes";
import { closePluginInboxItem } from "@/chat/inbox-items/plugin";

/**
 * Apply one plugin's batch of Inbox item changes in one transaction, so
 * readers and the version token see all of it or none of it. Each entry
 * uses the write of its `forConversation` call. The Slack cards and pushes
 * run after the commit, so they show the closed items.
 */
export function createPluginConversationChanges(args: {
  plugin: string;
  show: ShowInboxItem;
}): PluginConversationChanges {
  return {
    async apply(batch: ConversationChangeBatch) {
      const inboxItems = batch.inboxItems ?? [];
      const count = inboxItems.length;
      if (count > MAX_CONVERSATION_CHANGES) {
        throw new Error(
          `A conversation change batch has ${count} entries, more than the limit of ${MAX_CONVERSATION_CHANGES}`,
        );
      }
      if (count === 0) return;
      const closedItemIds = await getDb().transaction(async (tx) => {
        const closed: string[] = [];
        for (const entry of inboxItems) {
          // oxlint-disable-next-line no-await-in-loop -- A transaction runs its statements in order.
          const itemId = await closePluginInboxItem(tx, {
            ...entry.close,
            conversationId: entry.conversationId,
            plugin: args.plugin,
          });
          if (itemId) closed.push(itemId);
        }
        return closed;
      });
      await mapBounded(closedItemIds, args.show);
    },
  };
}
