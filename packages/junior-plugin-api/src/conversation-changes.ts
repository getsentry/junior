import type { PluginInboxItemSubject } from "./inbox-items";

/** Most entries in one batch. */
export const MAX_CONVERSATION_CHANGES = 100;

/**
 * Close the open Inbox item of this plugin with the subject. Do nothing when
 * no item is open, such as after a person dismissed it.
 */
export interface ConversationInboxItemChange {
  close: {
    subject: PluginInboxItemSubject;
    reason: string;
    status: "done" | "dismissed";
  };
  conversationId: string;
}

/**
 * Changes that a plugin makes together, such as the close of every ask of a
 * merged pull request. It is data, so no provider call can run while the
 * changes are not saved. A change at the provider changes no Annotation:
 * cards read the object live.
 */
export interface ConversationChangeBatch {
  inboxItems?: ConversationInboxItemChange[];
}

/**
 * Save Inbox item changes of a plugin in one write. Readers see all
 * the changes of a batch or none of them. Each entry has the checks of the
 * same `forConversation` call. When one entry fails, no entry is saved and
 * the call throws. A batch has at most `MAX_CONVERSATION_CHANGES` entries.
 * Core shows the closed items, such as on their Slack cards, after the write.
 */
export interface PluginConversationChanges {
  apply(batch: ConversationChangeBatch): Promise<void>;
}
