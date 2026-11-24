import type { PluginContext } from "./context";
import type { ObjectAnnotation } from "./object-annotations";
import type { EventPublisher } from "./events";
import type { PluginState } from "./state";
import type { PluginEventToolContext } from "./tools";

/**
 * One kind of Inbox item that a plugin adds, such as `pull_request`. Junior
 * stores it as `<plugin>:<kind>`, so each kind is unique. `label` names the
 * kind in the Inbox when the object's card cannot say more.
 */
export interface PluginInboxSubjectKind {
  kind: string;
  label: string;
  /**
   * Name the item's current ask from the object's live card, such as
   * `Ready to merge`. Return undefined to show `label`. The ask can change
   * while the item stays the same, such as from review to merge.
   */
  ask?: (object: ObjectAnnotation) => string | undefined;
  /**
   * The subject id is the provider id of a code change that this plugin
   * records (`codeLinks`), such as a GitHub pull request id. Junior then
   * reads the item's link and its search title from the code change.
   */
  codeChange?: boolean;
}

/**
 * What a plugin item is about: one of the plugin's registered `kind`s and
 * the id of the object, such as a pull request. The pair names one item: a
 * plugin has at most one open item for each pair. Junior reads the
 * object's title, state, and link from the object, and does not store them.
 */
export interface PluginInboxItemSubject {
  id: string;
  kind: string;
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
   * The ask changed for the assignees, such as from review to merge. Junior
   * pushes the open item to them again. Leave it unset for a change of text.
   */
  newAsk?: boolean;
  /**
   * What the notice is about, such as a pull request. An upsert with the
   * subject of an open item changes that item.
   */
  subject: PluginInboxItemSubject;
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
   * Close the open item of the subject. Do nothing when no item is open,
   * such as after a person dismissed it. Return whether an open item closed.
   */
  close(input: {
    subject: PluginInboxItemSubject;
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
  /** The Conversation that the item belongs to. */
  conversationId: string;
  /** The subject of the item, with the plugin's own kind. */
  subject: PluginInboxItemSubject;
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
