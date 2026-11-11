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
   * `conversation`: the final response stays in the Conversation. A child
   * agent's response goes to its parent, and an Automation run posts only its
   * declared result.
   */
  delivery: "location" | "conversation";
  promptMode: PromptMode;
  /** The Turn must end with its answer tool, or it is reminded once. */
  gated: boolean;
  tools: {
    agents: AgentTools;
    reviewDesk: boolean;
    subscriptions: boolean;
    userCustomization: boolean;
    reportBlocked: boolean;
    noReply: boolean;
    finishAutomationRun: boolean;
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
    reportBlocked: false,
    noReply: true,
    finishAutomationRun: false,
  },
};

// A person's Turn in a Thread runs like a Turn on a root, but it does not
// start or message child agents: their results would report to the parent as
// the wrong Actor.
const PERSON_IN_THREAD: TurnBehavior = {
  ...ROOT,
  tools: { ...ROOT.tools, agents: "none" },
};

// Every other Turn on a child is an agent invocation: an agent wrote its
// input, and its final response goes back to its parent.
const AGENT_IN_CHILD: TurnBehavior = {
  delivery: "conversation",
  promptMode: "child_agent",
  gated: false,
  tools: {
    agents: "children_and_parent",
    reviewDesk: false,
    subscriptions: false,
    userCustomization: false,
    reportBlocked: true,
    noReply: true,
    finishAutomationRun: false,
  },
};

const AUTOMATION_RUN: TurnBehavior = {
  delivery: "conversation",
  promptMode: "automation",
  gated: true,
  tools: {
    ...ROOT.tools,
    noReply: false,
    finishAutomationRun: true,
  },
};

/**
 * Return the behavior of one Turn. `automationRun` marks the dispatch Turn of
 * a Scheduled or Event automation run. Kind alone cannot mark it: the
 * dispatch Turn is the only gated Turn on an `automation` Conversation, and a
 * person's reply or a Watch Event Turn there runs like a Turn on a root.
 */
export function turnBehavior(args: {
  kind: ConversationKind;
  personInput: boolean;
  automationRun: boolean;
}): TurnBehavior {
  if (args.automationRun) return AUTOMATION_RUN;
  if (isTopLevelKind(args.kind)) return ROOT;
  if (!args.personInput) return AGENT_IN_CHILD;
  if (args.kind === "thread") return PERSON_IN_THREAD;
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
 * that an Automation Conversation owns. An Automation run posts only a
 * declared message; its failed execution shows on the Automation.
 */
export function postsRunNotices(dispatch: RunDispatch): boolean {
  return deliversFinalText(dispatch);
}
