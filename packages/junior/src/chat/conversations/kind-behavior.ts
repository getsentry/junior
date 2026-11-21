import type { Source } from "@sentry/junior-plugin-api";
import type { RunDispatch } from "@/chat/automation-result";
import type { ConversationKind } from "@/chat/conversations/store";
import type { PromptMode, TurnInputSender } from "@/chat/system-prompt-rules";

/**
 * Which agent tools a Turn gets. `children`: spawnAgent, and messageAgent
 * when spawnAgent is available. `children_and_parent`: the same, but
 * messageAgent stays available to reach the parent when the Turn is too deep
 * to spawn. `none`: neither.
 */
export type AgentTools = "none" | "children" | "children_and_parent";

/**
 * What one Turn does that depends on the Conversation kind and on who opened
 * the Turn. This module is the target home for those branches. The
 * `kind-behavior` baseline of the architecture check lists the legacy
 * branches that remain outside it.
 */
export type TurnBehavior = {
  /**
   * `location`: the runtime delivers the final response to the Location.
   * `conversation`: the final response stays in the Conversation. Only the
   * text of a `reply` call leaves it.
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
   * The Turn can pause until its web Actor signs in. A child agent's Turn
   * cannot wait for a person, even when it runs as the web user who started
   * it. Missing auth blocks it instead.
   */
  waitsForSignIn: boolean;
  /**
   * The Turn must end with `reply`, `noReply`, or `reportBlocked`, or it is
   * reminded once.
   */
  gated: boolean;
  /**
   * The error that fails a gated Turn that still has no answer after the
   * reminder. Without it, the Turn ends quietly.
   */
  missingAnswerError?: string;
  /**
   * `parent`: a failed Turn, also one that ends without an answer, sends its
   * failure to the parent agent. `none`: the failure stays in the
   * Conversation and in telemetry.
   */
  failureNotice: "none" | "parent";
  /**
   * Run the plugin tasks of a completed session, such as memory capture.
   * Memory is public, so a child agent never captures it.
   */
  sessionTasks: boolean;
  tools: {
    agents: AgentTools;
    inbox: boolean;
    subscriptions: boolean;
    userCustomization: boolean;
    /**
     * Where a `reply` goes. Only a gated Turn has it. `parent`: the parent
     * agent's mailbox. `automation`: the run's Destination, then its Slack
     * thread.
     */
    reply: "none" | "parent" | "automation";
    /**
     * Who gets a blocked report. `parent`: the parent agent. `automation`:
     * the Automation is blocked with the reason.
     */
    reportBlocked: "none" | "parent" | "automation";
    noReply: boolean;
    /**
     * `channel_thread`: the Turn's final response goes to its own channel,
     * so `messageAgent` is its only way to reach its parent. Its description
     * says when to use it.
     */
    messageAgent?: "channel_thread";
  };
};

const ROOT: TurnBehavior = {
  delivery: "location",
  promptMode: "conversation",
  idleNeedsPendingWork: false,
  waitsForSignIn: true,
  gated: false,
  failureNotice: "none",
  sessionTasks: true,
  tools: {
    agents: "children",
    inbox: true,
    subscriptions: true,
    userCustomization: true,
    reply: "none",
    reportBlocked: "none",
    noReply: true,
  },
};

// A person's Turn in a Thread runs like a Turn on a root, but it does not
// start or message child agents: their results would report to the parent as
// the wrong Actor.
const PERSON_IN_THREAD: TurnBehavior = {
  ...ROOT,
  promptMode: "thread",
  sender: "person",
  sessionTasks: false,
  tools: { ...ROOT.tools, agents: "none" },
};

// A child agent's Turn comes from its parent, its child agents, or its
// Watches. Its final response stays in its Conversation, and only a `reply`
// reaches the parent.
const CHILD_AGENT_TURN: TurnBehavior = {
  delivery: "conversation",
  promptMode: "child_agent",
  idleNeedsPendingWork: false,
  waitsForSignIn: false,
  gated: true,
  failureNotice: "none",
  sessionTasks: false,
  tools: {
    agents: "children_and_parent",
    inbox: false,
    subscriptions: false,
    userCustomization: false,
    reply: "parent",
    reportBlocked: "parent",
    noReply: true,
  },
};

// A channel Thread owns a whole provider place, such as a Slack code channel,
// as its Location. Every Turn, from a person, its parent, its Tasks, or its
// Watches, runs like a root Turn there: the people in that place are its
// audience. It reaches its parent only with `messageAgent`, and it never
// reports a result or a failure to the parent.
const CHANNEL_THREAD: TurnBehavior = {
  ...ROOT,
  sessionTasks: false,
  tools: {
    ...ROOT.tools,
    agents: "children_and_parent",
    messageAgent: "channel_thread",
  },
};

// Every Turn on a Thread that a person did not send.
const AGENT_IN_THREAD: TurnBehavior = {
  ...CHILD_AGENT_TURN,
  promptMode: "thread",
  sender: "agent",
};

// Every Turn of a Thread lists the tools of both senders, so the Thread keeps
// one tool list. The Turn's own tools say which of them it can use.
const THREAD_TOOLS: TurnBehavior["tools"] = {
  ...AGENT_IN_THREAD.tools,
  inbox: PERSON_IN_THREAD.tools.inbox,
  subscriptions: PERSON_IN_THREAD.tools.subscriptions,
  userCustomization: PERSON_IN_THREAD.tools.userCustomization,
};

// A Task does work for its parent, so its parent learns when it fails or ends
// without an answer.
const AGENT_IN_TASK: TurnBehavior = {
  ...CHILD_AGENT_TURN,
  missingAnswerError: "No reply was sent.",
  failureNotice: "parent",
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
  failureNotice: "none",
  sessionTasks: true,
  tools: {
    ...ROOT.tools,
    reply: "automation",
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
};

/** Return the behavior of one Turn. */
export function turnBehavior(args: {
  /** The Conversation is a channel Thread (`isChannelThread`). */
  channelThread?: boolean;
  kind: ConversationKind;
  personInput: boolean;
}): TurnBehavior {
  if (args.kind === "root") return ROOT;
  if (args.channelThread) {
    if (args.kind !== "thread") {
      throw new Error("Only a Thread can own a channel");
    }
    return CHANNEL_THREAD;
  }
  if (args.kind === "automation") {
    return args.personInput ? PERSON_IN_AUTOMATION : AUTOMATION_RUN;
  }
  if (args.kind === "thread") {
    return args.personInput ? PERSON_IN_THREAD : AGENT_IN_THREAD;
  }
  if (!args.personInput) return AGENT_IN_TASK;
  // Only an agent writes input to a task.
  throw new Error("A task Conversation cannot have a person's input");
}

/**
 * Return whether a Conversation of this kind can own a whole provider place,
 * such as a Slack code channel, as a channel Thread.
 */
export function canOwnChannel(kind: ConversationKind): boolean {
  return kind === "thread";
}

/**
 * Return whether a new child of `childKind` under a `parentKind` parent may
 * open a provider channel. Only a root's direct Thread may; a Task, or a
 * Thread deeper in the tree, stays in its parent's place.
 */
export function opensChildChannel(args: {
  childKind: ConversationKind;
  parentKind: ConversationKind;
}): boolean {
  return args.parentKind === "root" && canOwnChannel(args.childKind);
}

/**
 * Return the tools that every Turn of one Prompt mode lists. A Turn of a mode
 * with two senders can list more than its own tools. The listed tools that it
 * cannot use are disabled.
 */
export function promptModeTurnTools(mode: PromptMode): TurnBehavior["tools"] {
  if (mode === "automation") return AUTOMATION_RUN.tools;
  if (mode === "child_agent") return AGENT_IN_TASK.tools;
  if (mode === "thread") return THREAD_TOOLS;
  return ROOT.tools;
}

/**
 * Return the tools that one Turn lists. A channel Thread is not a Prompt
 * mode: it runs with the root prompt, but lists its own tools, because its
 * `messageAgent` reaches its parent.
 */
export function listedTurnTools(behavior: TurnBehavior): TurnBehavior["tools"] {
  if (behavior === CHANNEL_THREAD) return CHANNEL_THREAD.tools;
  return promptModeTurnTools(behavior.promptMode);
}

/** Return whether a Conversation of this kind has no parent. */
export function isTopLevelKind(kind: ConversationKind): boolean {
  return kind === "root" || kind === "automation";
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
    case "agent_invocation":
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
    case "agent_invocation":
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
