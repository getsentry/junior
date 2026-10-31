/** The thing a Review item is about, such as a pull request. */
export interface PluginReviewItemSubject {
  /** Stable id that Search matches, such as a URL. */
  id: string;
  title?: string;
  url?: string;
}

/** A notice that a plugin puts on the review desk. */
export interface PluginReviewNotice {
  /** Junior assigns the User linked to each Identity. */
  assigneeIdentityIds: string[];
  /** Markdown details for the person. */
  body: string;
  /**
   * Stable key for what the notice is about. A plugin has at most one open
   * item for each key.
   */
  dedupeKey: string;
  subject?: PluginReviewItemSubject;
  title: string;
}

/**
 * Review items that a plugin adds and closes from its own events. Each item
 * belongs to one Conversation. Core owns visibility, assignment rules, and
 * the Slack cards.
 */
export interface PluginReviewItems {
  /** Add an open notice, or replace the content of the open one with the key. */
  upsert(notice: PluginReviewNotice): Promise<void>;
  /** Close the open item with the key. Do nothing when no item is open. */
  close(input: {
    dedupeKey: string;
    reason: string;
    status: "done" | "dismissed";
  }): Promise<void>;
}

/** Review items of a plugin, for the Conversation that each item belongs to. */
export interface PluginConversationReviewItems {
  forConversation(conversationId: string): PluginReviewItems;
}
