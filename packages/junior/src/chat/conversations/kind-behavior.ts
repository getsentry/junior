import {
  FINISH_AUTOMATION_RUN_TOOL_NAME,
  MISSING_RESULT_REMINDER,
  type RunDispatch,
} from "@/chat/automation-result";
import type { ConversationKind } from "@/chat/conversations/store";
import type { PromptMode } from "@/chat/system-prompt-rules";

/**
 * What one Turn does that depends on the Conversation kind and on who opened
 * the Turn. This module is the only place that branches on them.
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
  /** The tools that must end the Turn, and what happens when none does. */
  answer?: {
    tools: readonly string[];
    reminder: string;
    onMissing: "quiet" | "tell_parent" | "post_nothing";
  };
  tools: {
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
  tools: {
    reviewDesk: true,
    subscriptions: true,
    userCustomization: true,
    reportBlocked: false,
    noReply: true,
    finishAutomationRun: false,
  },
};

/** Tools of a root Turn, for a tool context built outside an agent Run. */
export const ROOT_TURN_TOOLS = ROOT.tools;

// Every other Turn on a child is an agent invocation: an agent wrote its
// input, and its final response goes back to its parent.
const AGENT_IN_CHILD: TurnBehavior = {
  delivery: "conversation",
  promptMode: "child_agent",
  tools: {
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
  answer: {
    tools: [FINISH_AUTOMATION_RUN_TOOL_NAME],
    reminder: MISSING_RESULT_REMINDER,
    onMissing: "post_nothing",
  },
  tools: {
    reviewDesk: true,
    subscriptions: true,
    userCustomization: true,
    reportBlocked: false,
    noReply: false,
    finishAutomationRun: true,
  },
};

/**
 * Return the behavior of one Turn. `automationRun` marks a Scheduled or Event
 * automation run. It is a temporary bridge until Conversation kind
 * `automation` replaces it.
 *
 * TODO(dcramer): Remove `automationRun` when kind `automation` ships.
 */
export function turnBehavior(args: {
  kind: ConversationKind;
  personInput: boolean;
  automationRun: boolean;
}): TurnBehavior {
  if (args.automationRun) return AUTOMATION_RUN;
  // A person's Turn in a Thread runs like a Turn on a root.
  if (args.kind === "root" || args.personInput) return ROOT;
  return AGENT_IN_CHILD;
}

/** Return whether a person sent input from this Source. */
export function isPersonInput(source: string | undefined): boolean {
  return source === "web" || source === "slack";
}

/**
 * Return whether the runtime delivers the final response of a Slack or
 * dispatch run. Only root Conversations reach these paths: a person's Turn in
 * a Thread runs on the Conversation Turn worker. A dispatch with no outcomes
 * delivers nothing.
 */
export function deliversFinalText(dispatch: RunDispatch): boolean {
  const behavior = turnBehavior({
    kind: "root",
    personInput: dispatch === undefined,
    automationRun: dispatch?.declaresResult === true,
  });
  return behavior.delivery === "location" && dispatch?.outcomes?.length !== 0;
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
