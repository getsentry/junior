/**
 * Snapshot builders for isolated Guardian action-review evals.
 *
 * Cases feed exact ToolActionProposal objects to the real reviewer. Keep
 * proposals realistic and free of eval-shaped instructions in userIntent.
 */
import type {
  RootConversation,
  ToolActionDecision,
  ToolActionEvidence,
  ToolActionProposal,
} from "@/chat/guardian/proposal";
import type { ToolActionPriorRejection } from "@/chat/guardian/history";
import { agentToolSpec } from "../../src/guardian-tools";

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
 * The tool of a snapshot. Name an agent tool, and the snapshot gets the
 * `tool` field that production sends for the input. Pass an object only for
 * a made-up tool that the agent does not have.
 */
export type SnapshotTool = string | ToolActionProposal["tool"];

/** A prior rejection whose tool is resolved like the proposal's tool. */
export type PriorRejectionSnapshot = Omit<ToolActionPriorRejection, "tool"> & {
  tool: SnapshotTool;
};

async function resolveTool(
  tool: SnapshotTool,
  input: Record<string, unknown>,
): Promise<ToolActionProposal["tool"]> {
  return typeof tool === "string" ? await agentToolSpec(tool, input) : tool;
}

/** Build one exact ToolActionProposal snapshot. */
export async function proposal(input: {
  context: ToolActionProposal["context"];
  evidence?: ToolActionEvidence;
  input: Record<string, unknown>;
  priorRejectedActions?: PriorRejectionSnapshot[];
  rootConversation?: RootConversation;
  tool: SnapshotTool;
}): Promise<ToolActionProposal> {
  const priorRejectedActions = await Promise.all(
    (input.priorRejectedActions ?? []).map(async (rejection) => ({
      ...rejection,
      tool: await resolveTool(rejection.tool, rejection.input),
    })),
  );
  return {
    context: input.context,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    input: input.input,
    ...(priorRejectedActions.length > 0 ? { priorRejectedActions } : {}),
    ...(input.rootConversation
      ? { rootConversation: input.rootConversation }
      : {}),
    tool: await resolveTool(input.tool, input.input),
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
  tool: SnapshotTool;
  riskLevel?: ToolActionPriorRejection["riskLevel"];
  userAuthorization?: ToolActionPriorRejection["userAuthorization"];
}): PriorRejectionSnapshot {
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
