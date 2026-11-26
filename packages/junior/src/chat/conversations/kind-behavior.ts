import type { Source } from "@sentry/junior-plugin-api";
import type { RunDispatch } from "@/chat/automation-result";
import type {
  Conversation,
  ConversationKind,
} from "@/chat/conversations/store";
import type { PromptMode, TurnInputSender } from "@/chat/system-prompt-rules";
import type { StaticToolName } from "@/chat/tool-support/registry";

/**
 * Which agent tools a Turn gets. `children`: spawnAgent, and messageAgent
 * when spawnAgent is available. `children_and_parent`: the same, but
 * messageAgent stays available to reach the parent when the Turn is too deep
 * to spawn.
 */
export type AgentTools = "children" | "children_and_parent";

/**
 * What one Turn does that depends on the Conversation kind and on who opened
 * the Turn. This module is the target home for those branches. The
 * `kind-behavior` baseline of the architecture check lists the legacy
 * branches that remain outside it.
 */
export type TurnBehavior = {
  /**
   * `location`: the runtime delivers the final response to the Location.
   * `conversation`: the final response stays in the Conversation. A child
   * agent's final response also goes to its parent, and an Automation run
   * posts only the text of its `reply` call.
   */
  delivery: "location" | "conversation";
  /**
   * The system prompt of the Turn. Every Turn of a Thread has the `thread`
   * mode, and every Turn of an Automation Conversation has the `automation`
   * mode, so each keeps one system prompt and one tool list.
   */
  promptMode: PromptMode;
  /**
   * Who sent the input of a Turn in a mode with two senders. The Turn context
   * states it, so the Turn follows only the mode's rules for that sender.
   */
  sender?: TurnInputSender;
  /**
   * An ended Turn starts a cache-warming idle period only while a child agent
   * or a Watch can start the next Turn. An Automation run almost never gets
   * an answer from a person.
   */
  idleNeedsPendingWork: boolean;
  /**
   * The Turn can pause until its web Actor signs in. Only a person's Turn
   * waits. An agent's Turn in a child agent cannot wait for a person, even
   * when it runs as the web user who started it. Missing auth blocks it
   * instead.
   */
  waitsForSignIn: boolean;
  /**
   * The Turn must end with `reply`, `noReply`, or `reportBlocked`, or it is
   * reminded once. Its final text is never delivered. Only an Automation run
   * is gated, because its reply goes to people in a channel.
   */
  gated: boolean;
  /**
   * Run the plugin tasks of a completed session, such as memory capture.
   * Memory is public, so a child agent never captures it.
   */
  sessionTasks: boolean;
  /**
   * A completed Turn updates the Conversation summary that search reads.
   * With `sessionTasks`, the session tasks include this update.
   */
  conversationMetadata: boolean;
  /**
   * The first request of the Conversation gets the open Conversations that
   * may cover the same work. A child agent or an Automation run already
   * knows what it works on.
   */
  relatedConversations: boolean;
  tools: {
    agents: AgentTools;
    subscriptions: boolean;
    userCustomization: boolean;
    /**
     * The Turn changes settings for its person, such as the configuration of
     * its Slack channel or Space, or the Space that a Conversation is in.
     * Only a person's request changes them, so only a person's Turn has it.
     */
    settings: boolean;
    /**
     * The Turn has `reply`. Only a gated Turn has it. The reply goes to the
     * run's Destination, then its Slack thread.
     */
    reply: boolean;
    /**
     * Who gets a blocked report. `parent`: the parent agent. `automation`:
     * the Automation is blocked with the reason.
     */
    reportBlocked: "none" | "parent" | "automation";
    noReply: boolean;
    /**
     * When set, the Turn lists only these core tools. It gets no run-built,
     * plugin, or MCP tools, and no skills.
     */
    only?: readonly string[];
    /**
     * Deferred tools that the Turn lists in the model tool list, because the
     * model needs them on most Turns.
     */
    direct?: readonly string[];
  };
};

const ROOT: TurnBehavior = {
  delivery: "location",
  promptMode: "conversation",
  idleNeedsPendingWork: false,
  waitsForSignIn: true,
  gated: false,
  sessionTasks: true,
  conversationMetadata: true,
  relatedConversations: true,
  tools: {
    agents: "children",
    subscriptions: true,
    userCustomization: true,
    settings: true,
    reply: false,
    reportBlocked: "none",
    noReply: true,
  },
};

// A Turn on a root that no person sent, such as an Event. It did not come
// from a request, so it gets no related Conversations.
const ROOT_RUNTIME_TURN: TurnBehavior = {
  ...ROOT,
  relatedConversations: false,
  tools: { ...ROOT.tools, settings: false },
};

// A person's Turn in a Thread runs like a Turn on a root, and reports to the
// parent like every Turn of a child. Its child agents run as the person, like
// every child agent runs as the Actor of the Turn that started it.
const PERSON_IN_THREAD: TurnBehavior = {
  ...ROOT,
  promptMode: "thread",
  sender: "person",
  sessionTasks: false,
  relatedConversations: false,
  tools: { ...ROOT.tools, agents: "children_and_parent" },
};

// A child agent's Turn comes from its parent, its child agents, or its
// Watches. Its final response stays in its Conversation and is its reply to
// the parent. It has no `noReply`: every Turn reports to the parent, and the
// parent decides what to do with it.
const CHILD_AGENT_TURN: TurnBehavior = {
  delivery: "conversation",
  promptMode: "child_agent",
  idleNeedsPendingWork: false,
  waitsForSignIn: false,
  gated: false,
  sessionTasks: false,
  // Only its parent reads a Task, so a Task has no summary.
  conversationMetadata: false,
  relatedConversations: false,
  tools: {
    agents: "children_and_parent",
    subscriptions: false,
    userCustomization: false,
    settings: false,
    reply: false,
    reportBlocked: "parent",
    noReply: false,
  },
};

// A person's answer to an Inbox item of a Task. The Task keeps its one
// system prompt and tool list, and it still reports to its parent. The Turn
// runs as the person, so it can wait for their sign-in.
const PERSON_IN_TASK: TurnBehavior = {
  ...CHILD_AGENT_TURN,
  waitsForSignIn: true,
};

// Every Turn on a Thread that a person did not send.
const AGENT_IN_THREAD: TurnBehavior = {
  ...CHILD_AGENT_TURN,
  promptMode: "thread",
  sender: "agent",
  // People find a Thread by its summary.
  conversationMetadata: true,
};

// Every Turn of a Thread lists the tools of both senders, so the Thread keeps
// one tool list. The Turn's own tools say which of them it can use.
const THREAD_TOOLS: TurnBehavior["tools"] = {
  ...AGENT_IN_THREAD.tools,
  subscriptions: PERSON_IN_THREAD.tools.subscriptions,
  userCustomization: PERSON_IN_THREAD.tools.userCustomization,
  settings: PERSON_IN_THREAD.tools.settings,
  noReply: PERSON_IN_THREAD.tools.noReply,
};

// The dispatch Turn and every Watch Event Turn of an Automation run must
// answer.
const AUTOMATION_RUN: TurnBehavior = {
  delivery: "conversation",
  promptMode: "automation",
  sender: "automation",
  idleNeedsPendingWork: true,
  waitsForSignIn: true,
  gated: true,
  sessionTasks: true,
  conversationMetadata: true,
  relatedConversations: false,
  tools: {
    ...ROOT.tools,
    settings: false,
    reply: true,
    reportBlocked: "automation",
  },
};

// A person who replies in an Automation run's thread gets a Turn that runs
// like a Turn on a root. It lists the run's tools, so the Conversation keeps
// one tool list, and its own tools have no `reply` or `reportBlocked`.
const PERSON_IN_AUTOMATION: TurnBehavior = {
  ...ROOT,
  promptMode: "automation",
  sender: "person",
  relatedConversations: false,
};

// A Lead finds, starts, and steers the Space's other Conversations, its
// child agents, and never does their work. So it gets only the tools for
// that and its questions to members, and no sandbox, skills, MCP, plugin,
// or provider tools. A child reads provider state for it. Automation tools
// stay out until a Lead can pick a Slack Destination for one.
const LEAD_TOOLS = [
  "startAgent",
  "messageAgent",
  "listAgents",
  "stopAgent",
  "archiveAgent",
  "searchConversationEvents",
  "readConversationEvent",
  "searchInboxItems",
  "addInboxItem",
  "updateInboxItem",
  "searchEventTypes",
  "watchEvents",
  "watchTimer",
  "listWatches",
  "stopWatchingResources",
  "systemTime",
  "updateUserCustomization",
  "setConfiguration",
  "listSpaces",
  "moveConversationToSpace",
  "noReply",
] as const satisfies readonly StaticToolName[];

// The tools a Lead uses on most Turns to find and follow its person's work.
const LEAD_DIRECT_TOOLS = [
  "listAgents",
  "searchConversationEvents",
  "readConversationEvent",
  "searchInboxItems",
  "searchEventTypes",
  "listWatches",
  "stopWatchingResources",
  "setConfiguration",
] as const satisfies readonly (typeof LEAD_TOOLS)[number][];

const LEAD: TurnBehavior = {
  ...ROOT,
  promptMode: "lead",
  sessionTasks: false,
  conversationMetadata: false,
  tools: {
    ...ROOT.tools,
    subscriptions: false,
    only: LEAD_TOOLS,
    direct: LEAD_DIRECT_TOOLS,
  },
};

// A Lead Turn that no person sent, such as a Watch Event or another agent's
// message. It lists the Lead's tools, so the Lead keeps one tool list, but
// it changes no settings: only a person's request does.
const LEAD_RUNTIME_TURN: TurnBehavior = {
  ...LEAD,
  tools: { ...LEAD.tools, settings: false },
};

/**
 * Return the behavior of one Turn. A `thread` with a parent runs like a
 * top-level `thread`, and also reports to its parent.
 */
export function turnBehavior(args: {
  kind: ConversationKind;
  hasParent: boolean;
  personInput: boolean;
}): TurnBehavior {
  switch (args.kind) {
    case "thread":
      if (args.hasParent) {
        return args.personInput ? PERSON_IN_THREAD : AGENT_IN_THREAD;
      }
      return args.personInput ? ROOT : ROOT_RUNTIME_TURN;
    case "automation":
      return args.personInput ? PERSON_IN_AUTOMATION : AUTOMATION_RUN;
    case "task":
      // A person's only input to a Task is the answer to its own Inbox item.
      return args.personInput ? PERSON_IN_TASK : CHILD_AGENT_TURN;
    case "lead":
      return args.personInput ? LEAD : LEAD_RUNTIME_TURN;
  }
}

/**
 * Return the tools that every Turn of one Prompt mode lists. A Turn of a mode
 * with two senders can list more than its own tools. The listed tools that it
 * cannot use are disabled.
 */
export function promptModeTurnTools(mode: PromptMode): TurnBehavior["tools"] {
  switch (mode) {
    case "automation":
      return AUTOMATION_RUN.tools;
    case "child_agent":
      return CHILD_AGENT_TURN.tools;
    case "thread":
      return THREAD_TOOLS;
    case "conversation":
      return ROOT.tools;
    case "lead":
      return LEAD.tools;
  }
}

/**
 * Return whether Turns update the Conversation metadata of this kind. Only
 * its parent reads a Task, so a Task has no summary.
 */
export function hasConversationMetadata(kind: ConversationKind): boolean {
  return kind !== "task";
}

/**
 * Return whether a Conversation takes a person's answer to its own Inbox
 * item as the person's web input, also when it takes no other web input.
 * Every child agent asks its own questions, so a Task gets its answers too.
 */
export function takesInboxAnswersAsWebInput(
  conversation: Pick<Conversation, "parentConversationId">,
): boolean {
  return !isTopLevel(conversation);
}

/**
 * Return whether a person can put a Conversation in a Space: a top-level
 * `thread`. A child agent is in the Space of its tree, and a Lead, an
 * Automation run, or a Task never moves.
 */
export function canMoveToSpace(
  conversation: Pick<
    Conversation,
    "kind" | "parentConversationId" | "rootConversationId" | "spaceId"
  >,
): boolean {
  return conversation.kind === "thread" && isTopLevelWork(conversation);
}

/**
 * Return whether a Conversation copies its root's visibility: it has a
 * parent. A root takes the visibility of its Destination or Space.
 */
export function copiesRootVisibility(
  conversation: Pick<Conversation, "parentConversationId">,
): boolean {
  return !isTopLevel(conversation);
}

/**
 * Return whether a parent of this kind has a cap on its active child agents.
 * A Lead's children are its Space's Conversations, so a Lead has none.
 */
export function capsActiveChildren(
  kind: ConversationKind | undefined,
): boolean {
  return kind !== "lead";
}

/**
 * Return whether the children of a parent of this kind are top-level work:
 * a Lead's children are its Space's Conversations. They count as roots for
 * `limits.maxAgentDepth`, and each gets its own Destination.
 */
export function childrenAreTopLevel(
  kind: ConversationKind | null | undefined,
): boolean {
  return kind === "lead";
}

/**
 * Return whether a parent of this kind gets a reminder with a child's status
 * update that it can end the Turn with no reply. A Lead's members read each
 * reply that it posts.
 */
export function remindsNoReplyForChildStatus(
  kind: ConversationKind | undefined,
): boolean {
  return kind === "lead";
}

/** Return whether a Conversation of this kind stores its Space: a Lead. */
export function storesSpace(
  kind: ConversationKind | null | undefined,
): boolean {
  return kind === "lead";
}

/**
 * Return whether a Conversation is top-level work: it has no parent, or it
 * is a Lead's child. Top-level lists show it, and its child
 * agents move with it.
 */
export function isTopLevelWork(
  conversation: Pick<
    Conversation,
    "parentConversationId" | "rootConversationId" | "spaceId"
  >,
): boolean {
  // A Space's Lead is the root of its Space, so a Lead's child is a direct
  // child of a root that has a Space.
  return (
    isTopLevel(conversation) ||
    (conversation.spaceId !== undefined &&
      conversation.parentConversationId === conversation.rootConversationId)
  );
}

/**
 * Return whether a Conversation delivers to its Location: it has no parent,
 * or its Location is its own, such as a Slack Conversation in a Space.
 */
export function ownsLocation(
  conversation: Pick<Conversation, "ownLocation" | "parentConversationId">,
): boolean {
  return isTopLevel(conversation) || conversation.ownLocation === true;
}

/**
 * Return whether a write may keep a stored parent that is not its own. A
 * move into, out of, or between Spaces changes the parent only between no
 * parent and a Lead, so a write from before the move keeps the stored one.
 */
export function keepsStoredParent(
  stored: { id: string | null; isLead: boolean },
  incoming: { id: string | undefined; isLead: boolean },
): boolean {
  if (stored.id === (incoming.id ?? null)) return true;
  return (!stored.id || stored.isLead) && (!incoming.id || incoming.isLead);
}

/** Return whether a Conversation has no parent. */
export function isTopLevel(
  conversation: Pick<Conversation, "parentConversationId">,
): boolean {
  return !conversation.parentConversationId;
}

/**
 * Return whether a Conversation of this kind may have this parent edge. A
 * `thread` may have a parent, a Task must, and an Automation run or a Lead
 * never does.
 */
export function kindAllowsParent(
  kind: ConversationKind,
  hasParent: boolean,
): boolean {
  switch (kind) {
    case "thread":
      return true;
    case "task":
      return hasParent;
    case "automation":
    case "lead":
      return !hasParent;
  }
}

/** Return whether a Conversation is a child Thread: a `thread` with a parent. */
export function isThread(
  conversation: Pick<Conversation, "kind" | "parentConversationId">,
): boolean {
  return conversation.kind === "thread" && !isTopLevel(conversation);
}

/**
 * Return whether the watcher started this Conversation, so it already has
 * the Watch that its parent edge makes and a second one would repeat it.
 */
export function watcherStartedConversation(
  target: { parentConversationId?: string },
  watcherConversationId: string,
): boolean {
  return target.parentConversationId === watcherConversationId;
}

/** Return whether a person sent input from this Source. */
export function isPersonInput(source: string | undefined): boolean {
  return source === "web" || source === "slack";
}

/** Narrow a Source to one that a person sent input from. */
export function isPersonSource(
  source: Source,
): source is Extract<Source, { kind: "slack" | "web" }> {
  return isPersonInput(source.kind);
}

/**
 * Return the chat platform of a Source that a person writes from, or
 * undefined for a runtime Source, such as an event or an Automation.
 */
export function personSourcePlatform(
  source: Source,
): "slack" | "local" | "web" | undefined {
  switch (source.kind) {
    case "slack":
    case "local":
    case "web":
      return source.kind;
    case "event":
    case "scheduled_automation":
    case "event_automation":
    case "plugin_dispatch":
    case "parent_message":
      return undefined;
  }
}

/** Return a short label that names a Source, such as `slack:T1:C1`. */
export function sourceLabel(source: Source): string {
  switch (source.kind) {
    case "slack":
      return `slack:${source.teamId}:${source.channelId}`;
    case "web":
    case "local":
      return `${source.kind}:${source.conversationId}`;
    case "event":
      return `event:${source.namespace}:${source.eventKey}`;
    case "scheduled_automation":
    case "event_automation":
    case "plugin_dispatch":
    case "parent_message":
      return source.kind;
  }
}

/**
 * Return whether the runtime delivers the final response of a Slack or
 * dispatch run. Only root Conversations reach these paths, so only an
 * Automation run keeps its final response in the Conversation. A dispatch
 * with no outcomes delivers nothing.
 */
export function deliversFinalText(dispatch: RunDispatch): boolean {
  return dispatch?.outcomes?.length !== 0 && !dispatch?.declaresResult;
}

/**
 * Return whether the runtime may post a failure reply or a status notice,
 * such as an auth prompt, for a run outside `finishedRunReply`. The rule is
 * the same as for a final response. A chat Turn may post, also in a thread
 * that an Automation Conversation owns. An Automation run posts only its
 * `reply` text; its failed execution shows on the Automation.
 */
export function postsRunNotices(dispatch: RunDispatch): boolean {
  return deliversFinalText(dispatch);
}

/**
 * Return whether the task instructions of a dispatch run can invoke skills.
 * Only an Automation creator writes them. Another dispatch, such as a plugin
 * dispatch, has no person's text.
 */
export function dispatchInstructionsInvokeSkills(
  dispatch: RunDispatch,
): boolean {
  return dispatch?.declaresResult === true;
}
