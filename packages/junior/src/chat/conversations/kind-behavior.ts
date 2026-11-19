import type { RunDispatch } from "@/chat/automation-result";
import type { ConversationKind } from "@/chat/conversations/store";
import type { PromptMode, TurnInputSender } from "@/chat/system-prompt-rules";
import type { StaticToolName } from "@/chat/tools/registry";

/**
 * Which agent tools a Turn gets. `children`: spawnAgent, and messageAgent
 * when spawnAgent is available. `children_and_parent`: the same, but
 * messageAgent stays available to reach the parent when the Turn is too deep
 * to spawn. `lead`: only messageAgent, to other top-level agents.
 * `none`: neither.
 */
export type AgentTools = "none" | "children" | "children_and_parent" | "lead";

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
     * When set, the Turn lists only these core tools. It gets no run-built,
     * plugin, or MCP tools, and no skills.
     */
    only?: readonly string[];
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

// A Lead finds, starts, and steers its person's other Conversations, and
// never does their work. So it gets only the tools for that, and no sandbox,
// skills, MCP, provider, or child-agent tools. Automation tools stay out
// until a Lead can pick a Slack Destination for one.
const LEAD_TOOLS = [
  "startConversation",
  "messageAgent",
  "searchConversations",
  "searchConversationEvents",
  "readConversationEvent",
  "searchReviewItems",
  "updateReviewItem",
  "searchEventTypes",
  "watchEvents",
  "watchTimer",
  "listWatches",
  "stopWatchingResources",
  "systemTime",
  "updateUserCustomization",
  "noReply",
] as const satisfies readonly StaticToolName[];

const LEAD: TurnBehavior = {
  ...ROOT,
  promptMode: "lead",
  sessionTasks: false,
  tools: {
    ...ROOT.tools,
    agents: "lead",
    subscriptions: false,
    only: LEAD_TOOLS,
  },
};

/** Return the behavior of one Turn. */
export function turnBehavior(args: {
  kind: ConversationKind;
  personInput: boolean;
}): TurnBehavior {
  switch (args.kind) {
    case "root":
      return ROOT;
    case "automation":
      return args.personInput ? PERSON_IN_AUTOMATION : AUTOMATION_RUN;
    case "thread":
      return args.personInput ? PERSON_IN_THREAD : AGENT_IN_THREAD;
    case "task":
      if (!args.personInput) return AGENT_IN_TASK;
      // Only an agent writes input to a task.
      throw new Error("A task Conversation cannot have a person's input");
    case "lead":
      return LEAD;
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
      return AGENT_IN_TASK.tools;
    case "thread":
      return THREAD_TOOLS;
    case "conversation":
      return ROOT.tools;
    case "lead":
      return LEAD.tools;
  }
}

/** Return whether a Conversation of this kind has no parent. */
export function isTopLevelKind(kind: ConversationKind): boolean {
  return kind === "root" || kind === "automation" || kind === "lead";
}

/**
 * Return whether other Conversations may watch a Conversation of this kind.
 * A child agent reports to its parent, so only top-level work reports its
 * status to Watches.
 */
export function acceptsConversationWatch(kind: ConversationKind): boolean {
  switch (kind) {
    case "root":
    case "automation":
    case "lead":
      return true;
    case "task":
    case "thread":
      return false;
  }
}

/** Return whether a person sent input from this Source. */
export function isPersonInput(source: string | undefined): boolean {
  return source === "web" || source === "slack";
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
