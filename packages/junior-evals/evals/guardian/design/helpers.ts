/**
 * Snapshot builders for the Guardian design suite.
 *
 * A case builds each proposal as core sends it today, with the builders of
 * the Guardian suite. Facts that the design adds and today's proposal lacks
 * go in the request's `facts`. Each case cites the rule of
 * `design/guardian.md` that sets its expected outcome.
 */
import type { ToolActionProposal } from "@/chat/guardian/proposal";
import { renderDataTag } from "@/chat/input-tags";
import { renderTaskInput } from "@/chat/task-input";
import type {
  DesignRuleId,
  FailureCategory,
  GuardianDesignAudience,
  GuardianDesignCall,
  GuardianDesignInput,
  GuardianDesignRequest,
  GuardianExpectation,
} from "../../../src/guardian-design-harness";
import { slackContext } from "../helpers";

export {
  evidence,
  localContext,
  priorRejection,
  privateWebContext,
  proposal,
  slackContext,
} from "../helpers";

/** One case of the suite. `request` builds the proposals when the case runs. */
export interface DesignCase {
  category: FailureCategory;
  expected: GuardianExpectation;
  name: string;
  request: () => Promise<GuardianDesignRequest>;
  rule: DesignRuleId;
}

/** The test name, with the rule and category that the report groups by. */
export function caseTitle(designCase: DesignCase): string {
  return `[${designCase.rule}/${designCase.category}] ${designCase.name}`;
}

/** The harness input of one case. */
export async function caseInput(
  designCase: DesignCase,
): Promise<GuardianDesignInput> {
  return {
    category: designCase.category,
    expected: designCase.expected,
    request: await designCase.request(),
    rule: designCase.rule,
  };
}

/** Facts of a call that changes one target. */
export function callOn(
  ref: string,
  audience: GuardianDesignAudience,
): GuardianDesignCall {
  return { target: { ref, audience } };
}

/** Facts of a call that changes a pull request that this work created. */
export function ownPrCall(
  ref: string,
  audience: GuardianDesignAudience = "world",
): GuardianDesignCall {
  return {
    target: { ref, audience, createdByThisWork: true },
  };
}

const EVENT_ACTOR = { platform: "system", name: "event" } as const;

/** Context of a Turn that a Watch Event started, as core runs it today. */
export function watchTurnContext(args: {
  about: string;
  authorText?: Parameters<typeof renderTaskInput>[0]["authorText"];
  doneBy?: { handle: string; mention: string };
  eventType: string;
  externalText?: string;
  identifier: string;
  intent: string;
  trustedSummary: string;
}): ToolActionProposal["context"] {
  const userIntent = renderTaskInput({
    about: args.about,
    ...(args.authorText ? { authorText: args.authorText } : undefined),
    ...(args.doneBy ? { doneBy: args.doneBy } : undefined),
    event: args.eventType,
    instructions: args.intent,
    source: "github",
    trustedSummary: args.trustedSummary,
    ...(args.externalText ? { externalText: args.externalText } : undefined),
  });
  return slackContext(userIntent, {
    actor: EVENT_ACTOR,
    credential: { actor: EVENT_ACTOR },
    source: {
      kind: "event",
      eventKey: `${args.eventType}:1`,
      eventType: args.eventType,
      identifier: args.identifier,
      namespace: "github",
    },
  });
}

/**
 * Context of a root Turn that another top-level agent's message started,
 * such as a Lead's message to a Conversation in its Space.
 */
export function agentMessageContext(args: {
  conversationId: string;
  senderConversationId: string;
  text: string;
}): ToolActionProposal["context"] {
  return slackContext(
    renderDataTag(
      "agent-message",
      {
        conversation_id: args.senderConversationId,
        source: "top_level_agent",
      },
      "Another top-level agent",
      args.text,
    ),
    {
      actor: EVENT_ACTOR,
      conversationId: args.conversationId,
      source: {
        kind: "event",
        eventKey: `agent-message:${args.senderConversationId}:1`,
        eventType: "agent.top_level_message",
        identifier: args.senderConversationId,
        namespace: "junior",
      },
    },
  );
}

/** Context of a child agent's Turn. The parent's text is its instruction. */
export function childContext(
  intent: string,
  overrides: Partial<ToolActionProposal["context"]> = {},
): ToolActionProposal["context"] {
  return slackContext(intent, {
    conversationId: "agent:guardian-design-child",
    source: { kind: "parent_message" },
    ...overrides,
  });
}

/** Context of a scheduled Automation run. Its instruction is the intent. */
export function automationContext(
  instructions: string,
): ToolActionProposal["context"] {
  const actor = { platform: "system", name: "scheduler" } as const;
  return slackContext(instructions, {
    actor,
    conversationId: "automation:guardian-design",
    credential: { actor },
    source: { kind: "scheduled_automation" },
  });
}

/** A Code Mode script with the earlier calls that it made, as core bounds it. */
export function script(
  source: string,
  calls: Array<{ input: unknown; toolName: string }>,
): NonNullable<ToolActionProposal["script"]> {
  return {
    calls: calls.map((call) => ({
      input: JSON.stringify(call.input),
      status: "completed" as const,
      toolName: call.toolName,
    })),
    omittedCalls: 0,
    source,
  };
}
