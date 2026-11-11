import type { RunDispatch } from "@/chat/automation-result";
import type { ConversationKind } from "@/chat/conversations/store";
import type { PromptMode } from "@/chat/system-prompt-rules";

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
  promptMode: PromptMode;
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
  tools: {
    agents: AgentTools;
    reviewDesk: boolean;
    subscriptions: boolean;
    userCustomization: boolean;
    /**
     * Where a `reply` goes. Only a gated Turn has it. `parent`: the parent
     * agent's inbox. `automation`: the run's Destination, then its Slack
     * thread.
     */
    reply: "none" | "parent" | "automation";
    /**
     * Who gets a blocked report. `parent`: the parent agent. `automation`:
     * the Automation is blocked with the reason.
     */
    reportBlocked: "none" | "parent" | "automation";
    noReply: boolean;
  };
};

const ROOT: TurnBehavior = {
  delivery: "location",
  promptMode: "conversation",
  gated: false,
  tools: {
    agents: "children",
    reviewDesk: true,
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
  tools: { ...ROOT.tools, agents: "none" },
};

// Every other Turn on a Thread comes from its parent, its child agents, or its
// Watches. Its final response stays in the Thread, and only a `reply` reaches
// the parent.
const AGENT_IN_THREAD: TurnBehavior = {
  delivery: "conversation",
  promptMode: "child_agent",
  gated: true,
  tools: {
    agents: "children_and_parent",
    reviewDesk: false,
    subscriptions: false,
    userCustomization: false,
    reply: "parent",
    reportBlocked: "parent",
    noReply: true,
  },
};

// A Task does work for its parent, so its parent learns when it ends without
// an answer.
const AGENT_IN_TASK: TurnBehavior = {
  ...AGENT_IN_THREAD,
  missingAnswerError: "No reply was sent.",
};

// The dispatch Turn and every Watch Event Turn of an Automation run must
// answer. A person who replies in the run's thread gets a root Turn.
const AUTOMATION_RUN: TurnBehavior = {
  delivery: "conversation",
  promptMode: "automation",
  gated: true,
  tools: {
    ...ROOT.tools,
    reply: "automation",
    reportBlocked: "automation",
  },
};

/** Return the behavior of one Turn. */
export function turnBehavior(args: {
  kind: ConversationKind;
  personInput: boolean;
}): TurnBehavior {
  if (args.kind === "root") return ROOT;
  if (args.kind === "automation") {
    return args.personInput ? ROOT : AUTOMATION_RUN;
  }
  if (args.kind === "thread") {
    return args.personInput ? PERSON_IN_THREAD : AGENT_IN_THREAD;
  }
  if (!args.personInput) return AGENT_IN_TASK;
  // Only an agent writes input to a task.
  throw new Error("A task Conversation cannot have a person's input");
}

/** Return whether a Conversation of this kind has no parent. */
export function isTopLevelKind(kind: ConversationKind): boolean {
  return kind === "root" || kind === "automation";
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
