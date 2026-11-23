import {
  MAX_CONVERSATION_CHANGES,
  type ConversationChangeBatch,
  type PluginConversationChanges,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { mapBounded } from "@/chat/fan-out";
import type { ShowInboxItem } from "@/chat/inbox-items/changes";
import { closePluginInboxItem } from "@/chat/inbox-items/plugin";
import { upsertPluginAnnotation } from "./annotations";

/**
 * Apply one plugin's batch of annotation and Inbox item changes in one
 * transaction, so readers and both version tokens see all of it or none of
 * it. Each entry uses the write of its `forConversation` call. The Slack
 * cards and pushes are outside calls, so they show the closed items after
 * the commit.
 */
export function createPluginConversationChanges(args: {
  plugin: string;
  show: ShowInboxItem;
}): PluginConversationChanges {
  return {
    async apply(batch: ConversationChangeBatch) {
      const annotations = batch.annotations ?? [];
      const inboxItems = batch.inboxItems ?? [];
      const count = annotations.length + inboxItems.length;
      if (count > MAX_CONVERSATION_CHANGES) {
        throw new Error(
          `A conversation change batch has ${count} entries, more than the limit of ${MAX_CONVERSATION_CHANGES}`,
        );
      }
      if (count === 0) return;
      const closedItemIds = await getDb().transaction(async (tx) => {
        for (const entry of annotations) {
          // oxlint-disable-next-line no-await-in-loop -- A transaction runs its statements in order.
          await upsertPluginAnnotation(tx, {
            annotation: entry.upsert,
            conversationId: entry.conversationId,
            plugin: args.plugin,
          });
        }
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
