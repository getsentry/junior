/**
 * Snapshot builders for isolated Guardian action-review evals.
 *
 * Cases feed exact ToolActionProposal objects to the real reviewer. Keep
 * proposals realistic and free of eval-shaped instructions in userIntent.
 */
import type {
  ToolActionDecision,
  ToolActionEvidence,
  ToolActionProposal,
} from "@/chat/guardian/proposal";
import type { ToolActionPriorRejection } from "@/chat/guardian/history";
import toolSpecs from "./tool-specs.json";

/** A tool that has a spec in `tool-specs.json`. */
type ToolSpecName = keyof typeof toolSpecs;

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
 * The `tool` field that production sends for a real tool. The spec comes from
 * `tool-specs.json`, which a harness test keeps equal to the real definition.
 * Pass the `proposalDescription` that the tool writes for this input.
 */
export function toolSpec(
  name: ToolSpecName,
  proposalDescription?: string,
): ToolActionProposal["tool"] {
  const { catalogSource, ...spec }: ToolActionProposal["tool"] =
    toolSpecs[name];
  // Production key order, so the eval prompt is the production prompt.
  return {
    ...spec,
    ...(proposalDescription ? { proposalDescription } : undefined),
    ...(catalogSource ? { catalogSource } : undefined),
  };
}

/** Build one exact ToolActionProposal snapshot. */
export function proposal(input: {
  context: ToolActionProposal["context"];
  evidence?: ToolActionEvidence;
  input: Record<string, unknown>;
  priorRejectedActions?: ToolActionPriorRejection[];
  tool: ToolActionProposal["tool"];
}): ToolActionProposal {
  return {
    context: input.context,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    input: input.input,
    ...(input.priorRejectedActions && input.priorRejectedActions.length > 0
      ? { priorRejectedActions: input.priorRejectedActions }
      : {}),
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
