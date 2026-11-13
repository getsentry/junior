/**
 * Snapshot builders for isolated Guardian action-review evals.
 *
 * Cases feed exact ToolActionProposal objects to the real reviewer. Keep
 * proposals realistic and free of eval-shaped instructions in userIntent.
 *
 * A case records the Run's transcript. The proposal gets the shape that core
 * sends: for a person's root Run, the visible messages in an author-labeled
 * root section, ending with the current message. The evidence keeps the
 * user messages and tool calls in order, without assistant text or tool
 * result bodies.
 */
import {
  type RootConversationMessage,
  type ToolActionDecision,
  type ToolActionEvidence,
  type ToolActionProposal,
  type ToolActionScript,
} from "@/chat/guardian/proposal";
import { TOOL_RESULT_NOT_SHOWN } from "@/chat/guardian/evidence";
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

/** One entry of a Run's transcript, in order and without aligned authors. */
export interface TranscriptEntry {
  role: ToolActionEvidence["entries"][number]["role"] | "assistant";
  text: string;
}

/** The bounded transcript of a Run, as a case records it. */
export interface Transcript {
  entries: TranscriptEntry[];
  omittedEntries: number;
}

/**
 * Build the root section of a person's root Run from the transcript, as core
 * reads it: each visible message in order. Core persists the current message
 * before the Run, so it is added last when the snapshot lacks it.
 */
function personRoot(
  transcript: Transcript | undefined,
  userIntent: string,
): RootConversationMessage[] {
  const messages: RootConversationMessage[] = (
    transcript?.entries ?? []
  ).flatMap((entry) =>
    entry.role === "user" || entry.role === "assistant"
      ? [{ author: entry.role, text: entry.text }]
      : [],
  );
  // A snapshot can already hold the current message, followed by steering
  // that the user sent during the Turn. Core reads each message once.
  if (
    !messages.some(
      (message) => message.author === "user" && message.text === userIntent,
    )
  ) {
    messages.push({ author: "user", text: userIntent });
  }
  return messages;
}

/**
 * Project the transcript to the evidence that core builds: assistant text is
 * left out, and a tool result shows only that its call returned.
 */
function shownEvidence(transcript: Transcript): ToolActionEvidence {
  return {
    entries: transcript.entries.flatMap(({ role, text }) =>
      role === "assistant"
        ? []
        : [
            {
              role,
              text: role.endsWith(" result") ? TOOL_RESULT_NOT_SHOWN : text,
            },
          ],
    ),
    omittedEntries: transcript.omittedEntries,
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
  /** The Run's transcript. The proposal gets the evidence that core builds. */
  evidence?: Transcript;
  input: Record<string, unknown>;
  priorRejectedActions?: PriorRejectionSnapshot[];
  /**
   * Author-labeled root Conversation, as core reads it at review time. For a
   * person's root Run, it is built from the evidence when not given.
   */
  root?: RootConversationMessage[];
  /** The Code Mode script that made the call, as core bounds it. */
  script?: ToolActionScript;
  tool: SnapshotTool;
}): Promise<ToolActionProposal> {
  // A person's Run reads its section from the evidence when a snapshot does
  // not give it. A system Actor's root Run, such as an Event Turn, keeps plain
  // evidence.
  const root =
    input.root ??
    (input.context.actor.platform !== "system"
      ? personRoot(input.evidence, input.context.userIntent)
      : undefined);
  const priorRejectedActions = await Promise.all(
    (input.priorRejectedActions ?? []).map(async (rejection) => ({
      ...rejection,
      tool: await resolveTool(rejection.tool, rejection.input),
    })),
  );
  return {
    context: input.context,
    ...(input.evidence ? { evidence: shownEvidence(input.evidence) } : {}),
    input: input.input,
    ...(priorRejectedActions.length > 0 ? { priorRejectedActions } : {}),
    ...(root ? { rootConversation: { messages: root, truncated: false } } : {}),
    ...(input.script ? { script: input.script } : {}),
    tool: await resolveTool(input.tool, input.input),
  };
}

/** The Run's transcript, in order and without author identity. */
export function evidence(
  entries: TranscriptEntry[],
  omittedEntries = 0,
): Transcript {
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
