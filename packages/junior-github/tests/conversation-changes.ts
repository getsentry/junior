import type {
  ConversationChangeBatch,
  PluginConversationAnnotations,
  PluginConversationChanges,
  PluginConversationInboxItems,
} from "@sentry/junior-plugin-api";

/**
 * Fake batch writes that apply each entry through the fake stores of a
 * harness, in the order of core. Core saves a batch in one transaction; the
 * plugin tests check only which entries the plugin sends, and `batches`
 * records which of them it sends together. A test without Inbox item stores
 * checks no item closes.
 */
export function conversationChangesThrough(stores: {
  annotations: PluginConversationAnnotations;
  batches?: ConversationChangeBatch[];
  inboxItems?: PluginConversationInboxItems;
}): PluginConversationChanges {
  return {
    async apply(batch) {
      stores.batches?.push(batch);
      for (const entry of batch.annotations ?? []) {
        await stores.annotations
          .forConversation(entry.conversationId)
          .upsert(entry.upsert);
      }
      const { inboxItems } = stores;
      if (!inboxItems) return;
      for (const entry of batch.inboxItems ?? []) {
        await inboxItems
          .forConversation(entry.conversationId)
          .close(entry.close);
      }
    },
  };
}
