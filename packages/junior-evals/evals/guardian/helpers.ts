/**
 * Snapshot builders for isolated Guardian action-review evals.
 *
 * Cases feed exact ToolActionProposal objects to the real reviewer. Keep
 * proposals realistic and free of eval-shaped instructions in userIntent.
 *
 * A person's root Run gets the shape that core sends: the visible messages
 * in an author-labeled root section, ending with the current message, and
 * evidence with only tool calls and results.
 */
import {
  CHILD_AGENT_USER_INTENT,
  type RootConversationMessage,
  type ToolActionDecision,
  type ToolActionEvidence,
  type ToolActionProposal,
} from "@/chat/tool-support/action-review";
import type { ToolActionPriorRejection } from "@/chat/tool-support/action-review-history";

const LOCAL_CONVERSATION_ID = "local:guardian-eval";

const LOCAL_SOURCE = {
  kind: "local" as const,
  visibility: "private" as const,
  conversationId: LOCAL_CONVERSATION_ID,
};

const LOCAL_DESTINATION = {
  platform: "local" as const,
  conversationId: LOCAL_CONVERSATION_ID,
};

const SLACK_SOURCE = {
  kind: "slack" as const,
  teamId: "TGUARDIAN",
  channelId: "CGUARDIAN",
  visibility: "public" as const,
};

const SLACK_DESTINATION = {
  platform: "slack" as const,
  teamId: "TGUARDIAN",
  channelId: "CGUARDIAN",
};

export interface GuardianCase {
  expectedDecision: ToolActionDecision;
  name: string;
  proposal: ToolActionProposal;
}

/** Core-owned local actor/context defaults for one proposal snapshot. */
export function localContext(
  userIntent: string,
  overrides: Partial<ToolActionProposal["context"]> = {},
): ToolActionProposal["context"] {
  return {
    actor: {
      platform: "local",
      userId: "local-user",
    },
    conversationId: LOCAL_CONVERSATION_ID,
    destination: LOCAL_DESTINATION,
    source: LOCAL_SOURCE,
    userIntent,
    ...overrides,
  };
}

/** Core-owned Slack actor/context defaults for one proposal snapshot. */
export function slackContext(
  userIntent: string,
  overrides: Partial<ToolActionProposal["context"]> = {},
): ToolActionProposal["context"] {
  return {
    actor: {
      platform: "slack",
      teamId: "TGUARDIAN",
      userId: "UACTOR",
    },
    conversationId: "slack:TGUARDIAN:CGUARDIAN",
    destination: SLACK_DESTINATION,
    source: SLACK_SOURCE,
    userIntent,
    ...overrides,
  };
}

/**
 * Build the root section of a person's root Run from unlabeled evidence, as
 * core reads it: each visible message in order, then the current message.
 * Core persists the current message before the Run, so it is always last.
 */
function personRoot(
  evidence: ToolActionEvidence | undefined,
  userIntent: string,
): RootConversationMessage[] {
  const messages: RootConversationMessage[] = (evidence?.entries ?? []).flatMap(
    (entry) =>
      entry.role === "user" || entry.role === "assistant"
        ? [{ author: entry.role, text: entry.text }]
        : [],
  );
  const last = messages.at(-1);
  if (last?.author !== "user" || last.text !== userIntent) {
    messages.push({ author: "user", text: userIntent });
  }
  return messages;
}

/** Build one exact ToolActionProposal snapshot. */
export function proposal(input: {
  context: ToolActionProposal["context"];
  evidence?: ToolActionEvidence;
  input: Record<string, unknown>;
  priorRejectedActions?: ToolActionPriorRejection[];
  /**
   * Author-labeled root Conversation, as core reads it at review time. For a
   * person's root Run, it is built from the evidence when not given.
   */
  root?: RootConversationMessage[];
  tool: ToolActionProposal["tool"];
}): ToolActionProposal {
  // Core reads the root section for a child and for a person's root Run. A
  // system Actor's root Run, such as an Event Turn, keeps plain evidence.
  const childAgent = input.context.userIntent === CHILD_AGENT_USER_INTENT;
  const personRun = !childAgent && input.context.actor.platform !== "system";
  const root = personRun
    ? (input.root ?? personRoot(input.evidence, input.context.userIntent))
    : input.root;
  // With a root section, the evidence of a root Run keeps only tool entries.
  const evidence =
    personRun && input.evidence
      ? {
          ...input.evidence,
          entries: input.evidence.entries.filter(
            (entry) => entry.role !== "user" && entry.role !== "assistant",
          ),
        }
      : input.evidence;
  return {
    context: input.context,
    ...(evidence ? { evidence } : {}),
    input: input.input,
    ...(input.priorRejectedActions && input.priorRejectedActions.length > 0
      ? { priorRejectedActions: input.priorRejectedActions }
      : {}),
    ...(root ? { rootConversation: { messages: root, truncated: false } } : {}),
    tool: input.tool,
  };
}

/** Chronological visible-conversation evidence without author identity. */
export function evidence(
  entries: Array<{
    role: ToolActionEvidence["entries"][number]["role"];
    text: string;
  }>,
  omittedEntries = 0,
): ToolActionEvidence {
  return { entries, omittedEntries };
}

/** Compact prior rejection recorded by the core execution gate. */
export function priorRejection(input: {
  decision: "ask" | "deny";
  input: Record<string, unknown>;
  reason: string;
  tool: ToolActionPriorRejection["tool"];
  riskLevel?: ToolActionPriorRejection["riskLevel"];
  userAuthorization?: ToolActionPriorRejection["userAuthorization"];
}): ToolActionPriorRejection {
  return {
    decision: input.decision,
    input: input.input,
    reason: input.reason,
    tool: input.tool,
    ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}),
    ...(input.userAuthorization
      ? { userAuthorization: input.userAuthorization }
      : {}),
  };
}
