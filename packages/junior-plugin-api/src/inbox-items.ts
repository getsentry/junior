import type { PluginCodeChanges } from "./code";
import type { PluginContext } from "./context";
import type { EventPublisher } from "./events";
import type { PluginState } from "./state";
import type { PluginEventToolContext } from "./tools";

/**
 * A code change title split by Conventional Commits, such as
 * `feat(api)!: Add retries`. The plugin that owns the code change parses it,
 * so the Inbox can lead with the words and show the rest as pills.
 */
export interface InboxItemSubjectTitleParts {
  /** The title without its type prefix, such as `Add retries`. */
  text: string;
  /** The change type as one word, such as `Feature`. Unset when unknown. */
  type?: string;
  /** The scope, such as `api`. */
  scope?: string;
  /** The title marks a breaking change, such as with `!`. */
  breaking?: boolean;
}

/** What a plugin item is about, such as a pull request. */
export interface InboxItemSubjectInput {
  id: string;
  title?: string;
  url?: string;
  /** Set only for a code change whose title follows Conventional Commits. */
  titleParts?: InboxItemSubjectTitleParts;
}

/**
 * An item that a plugin puts in the Inbox: a notice for information,
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
  subject?: InboxItemSubjectInput;
  /**
   * For an item that waits on its assignees, name their step, such as
   * `Ready to merge · #946`. It is the reason that the dashboard shows.
   */
  title: string;
  /**
   * Buttons that answer the item, in display order, such as `Resume`. An
   * item with choices waits on its assignees. The first click closes it as
   * done and calls the plugin's `inboxItemAnswered` hook with the choice.
   * The answer starts no Turn: the plugin does the work.
   */
  choices?: Array<{ label: string; description?: string }>;
  /**
   * The assignees must act, such as merge a pull request that is ready. The
   * item then waits on them: its Conversation shows in their Needs you, and
   * it counts in their Inbox. Leave it unset for a notice that is only for
   * information.
   */
  waitsOnAssignees?: boolean;
}

/**
 * Inbox items that a plugin adds and closes from its own events. Each item
 * belongs to one Conversation. Core owns visibility, assignment rules, and
 * the Slack cards.
 */
export interface PluginInboxItems {
  /** Add an open item, or replace the content of the open one with the key. */
  upsert(notice: PluginReviewNotice): Promise<void>;
  /**
   * Close the open item with the key. Do nothing when no item is open, such
   * as after a person dismissed it. Return whether an open item closed.
   */
  close(input: {
    dedupeKey: string;
    reason: string;
    status: "done" | "dismissed";
  }): Promise<boolean>;
}

/** Inbox items of a plugin, for the Conversation that each item belongs to. */
export interface PluginConversationInboxItems {
  forConversation(conversationId: string): PluginInboxItems;
}

/** A person picked one of the `choices` of an item that this plugin added. */
export interface InboxItemAnsweredHookContext extends PluginContext {
  /** The label of the picked choice. */
  choice: string;
  /** Junior's native code index, as from a plugin route. */
  codeChanges: PluginCodeChanges;
  /** The Conversation that the item belongs to. */
  conversationId: string;
  /** The plugin's own dedupe key of the item. */
  dedupeKey: string;
  /** Publish events, as from a plugin route. */
  events: EventPublisher;
  /** The closed item's id. It is the same on a retry of the same answer. */
  itemId: string;
  nowMs: number;
  /** Inbox items, as from a plugin route. */
  inboxItems: PluginConversationInboxItems;
  state: PluginState;
  /** Watches of the item's Conversation. */
  watches: PluginConversationWatches;
}

/** Watches of one Conversation, for a plugin outside a tool call. */
export interface PluginConversationWatches extends PluginEventToolContext {
  /**
   * Whether an active Watch of this Conversation starts a Turn for this
   * event type on this plugin resource. Watches of other Conversations and
   * event automations do not count.
   */
  watching(input: { eventType: string; identifier: string }): Promise<boolean>;
}
