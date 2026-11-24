import type { ConversationAnnotationInput } from "./annotations";

/** Most entries in one batch, annotations and Inbox items together. */
export const MAX_CONVERSATION_CHANGES = 100;

/** Add or replace one annotation of this plugin on a Conversation. */
export interface ConversationAnnotationChange {
  conversationId: string;
  upsert: ConversationAnnotationInput;
}

/**
 * Close the open Inbox item of this plugin with the key. Do nothing when no
 * item is open, such as after a person dismissed it.
 */
export interface ConversationInboxItemChange {
  close: {
    dedupeKey: string;
    reason: string;
    status: "done" | "dismissed";
  };
  conversationId: string;
}

/**
 * Changes that a plugin makes together, such as a chip that shows a merged
 * pull request and the close of its ask. It is data, so no provider call can
 * run while the changes are not saved.
 */
export interface ConversationChangeBatch {
  annotations?: ConversationAnnotationChange[];
  inboxItems?: ConversationInboxItemChange[];
}

/**
 * Save annotations and Inbox items of a plugin in one write. Readers see all
 * the changes of a batch or none of them. Each entry has the checks of the
 * same `forConversation` call. When one entry fails, no entry is saved and
 * the call throws. A batch has at most `MAX_CONVERSATION_CHANGES` entries.
 * Core shows the closed items, such as on their Slack cards, after the write.
 */
export interface PluginConversationChanges {
  apply(batch: ConversationChangeBatch): Promise<void>;
}
