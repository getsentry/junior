import type { PluginAnnotations } from "./annotations";
import type { PluginCodeChanges } from "./code";
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
   * Name the ask of the person who reads the item, from the object's live
   * card, such as `Review requested` for a reviewer and `Ready to merge`
   * for the author. Return undefined to show `label`. The ask can change
   * while the item stays the same, such as from review to merge.
   */
  ask?: (
    object: ObjectAnnotation,
    viewer: PluginInboxViewer,
  ) => string | undefined;
  /**
   * The subject id is the provider id of a code change that this plugin
   * records (`codeLinks`), such as a GitHub pull request id. Junior then
   * reads the item's link and its search title from the code change.
   */
  codeChange?: boolean;
  /**
   * Where the owner Conversation of an item is. Each item belongs to one
   * Conversation, which decides who can see it. Junior finds it in the row
   * of `table` whose `subjectId` column holds the item's subject id, and
   * reads the `conversationId` column of that row. Name a table of this
   * plugin and its columns in snake_case. At most one row can have the
   * subject id and a set Conversation: add a unique index for it.
   *
   * `annotation` names the Conversation that first saved one of this
   * plugin's object Annotations whose `objectId` is the subject id, such as
   * the Conversation that created a GitHub issue.
   */
  owner: PluginInboxSubjectOwner | "annotation";
  /**
   * Each assignee has their own place on the object, such as a GitHub
   * assignee or reviewer. A dismiss then removes only the person who
   * dismissed the item. Junior first calls the plugin's
   * `inboxItemDismissed` hook, which removes them on the provider. When the
   * hook fails, the dismiss fails and the person stays. The item closes when
   * nobody is left.
   */
  dismissLeaves?: boolean;
}

/** The table and columns that map a subject id to its owner Conversation. */
export interface PluginInboxSubjectOwner {
  conversationId: string;
  subjectId: string;
  table: string;
}

/**
 * The person who reads an item. `handle` is their account of the plugin's
 * provider, such as a GitHub login, when they linked one.
 */
export interface PluginInboxViewer {
  handle?: string;
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
   * Everyone who has an ask on the object now. Junior assigns the User
   * linked to each Identity, but only when that User is in the notice's
   * Conversation. A person who is on the open item and not in this list
   * leaves it: Junior cancels their snooze and clears their push. When
   * nobody is left, the item closes.
   */
  assigneeIdentityIds: string[];
  /**
   * The people in `assigneeIdentityIds` whose ask the event behind this
   * upsert gave, such as a review request. Only they join the item, and
   * Junior pushes it to them. The others stay only when they are on the
   * open item already, so a person who left comes back only with a new ask.
   */
  askedIdentityIds: string[];
  /** Markdown details for the person. */
  body: string;
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
  /** Add an open item, or change the open one of the subject. */
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

/**
 * A person dismissed an item of a subject kind with `dismissLeaves`. The
 * plugin removes them from the object on the provider, such as from a
 * GitHub issue's assignees.
 */
export interface InboxItemDismissedHookContext extends PluginContext {
  /** Annotations of the Conversation that the item belongs to. */
  annotations: PluginAnnotations;
  /** The Conversation that the item belongs to. */
  conversationId: string;
  /**
   * The person's account of the plugin's provider, such as a GitHub login.
   * Unset when they linked none.
   */
  handle?: string;
  nowMs: number;
  /** The subject of the item, with the plugin's own kind. */
  subject: PluginInboxItemSubject;
}

/** A person picked one of the `choices` of an item that this plugin added. */
export interface InboxItemAnsweredHookContext extends PluginContext {
  /** The label of the picked choice. */
  choice: string;
  /** Junior's native code index, as from a plugin route. */
  codeChanges: PluginCodeChanges;
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
