/**
 * An item that a plugin puts on the review desk: a notice for information,
 * or an ask that waits on its assignees.
 */
export interface PluginReviewNotice {
  /**
   * Junior assigns the User linked to each Identity, but only when that User
   * is in the notice's Conversation. It leaves out the others.
   */
  assigneeIdentityIds: string[];
  /** Markdown details for the person. */
  body: string;
  /**
   * Stable key for what the notice is about. A plugin has at most one open
   * item for each key.
   */
  dedupeKey: string;
  /** What the notice is about, such as a pull request. Search matches `id`. */
  subject?: { id: string; title?: string; url?: string };
  /**
   * For an item that waits on its assignees, name their step, such as
   * `Ready to merge · #946`. It is the reason that the dashboard shows.
   */
  title: string;
  /**
   * The assignees must act, such as merge a pull request that is ready. The
   * item then waits on them: its Conversation shows in their Needs you, and
   * it counts in their Inbox. Leave it unset for a notice that is only for
   * information.
   */
  waitsOnAssignees?: boolean;
}

/**
 * Review items that a plugin adds and closes from its own events. Each item
 * belongs to one Conversation. Core owns visibility, assignment rules, and
 * the Slack cards.
 */
export interface PluginReviewItems {
  /** Add an open item, or replace the content of the open one with the key. */
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
