/**
 * Isolated Guardian action-review harness.
 *
 * Feeds exact ToolActionProposal snapshots to the real
 * createGuardianActionReviewer path without running the main agent, Slack
 * transport, sandbox egress, or Postgres.
 */
import {
  createHarness,
  type DescribeEvalOptions,
  type JsonValue,
} from "vitest-evals";
import { completeObject } from "@/chat/pi/client";
import { createGuardianActionReviewer } from "@/chat/services/guardian-action-review";
import type {
  ToolActionDecision,
  ToolActionProposal,
  ToolActionReviewDecision,
} from "@/chat/tool-support/action-review";

const GUARDIAN_EVAL_TIMEOUT_MS = 60_000;

export interface GuardianEvalInput {
  /** Exact proposal snapshot fed to the real Guardian reviewer. */
  proposal: ToolActionProposal;
  /** Expected allow/ask/deny decision. */
  expectedDecision: ToolActionDecision;
}

export interface GuardianEvalOutput extends Record<string, JsonValue> {
  costUsd: number | null;
  decision: ToolActionDecision;
  expectedDecision: ToolActionDecision;
  reason: string;
  riskLevel: string;
  userAuthorization: string;
}

function resolveGuardianModelId(): string {
  const configured = process.env.AI_GUARDIAN_MODEL?.trim();
  if (configured) {
    return configured;
  }
  return "openai/gpt-5.6-luna";
}

/** Run one Guardian proposal through the production reviewer boundary. */
export async function reviewGuardianProposal(
  proposal: ToolActionProposal,
  options?: { signal?: AbortSignal },
): Promise<ToolActionReviewDecision> {
  const reviewer = createGuardianActionReviewer({
    completeObject,
    modelId: resolveGuardianModelId(),
  });
  return reviewer.review(proposal, options);
}

/** Lightweight vitest-evals harness for isolated Guardian decision cases. */
export const guardianHarness = createHarness<
  GuardianEvalInput,
  GuardianEvalOutput
>({
  name: "guardian",
  run: async ({ input, signal }) => {
    const timeoutSignal = AbortSignal.timeout(GUARDIAN_EVAL_TIMEOUT_MS);
    const reviewSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const decision = await reviewGuardianProposal(input.proposal, {
      signal: reviewSignal,
    });
    const output: GuardianEvalOutput = {
      costUsd: decision.costUsd ?? null,
      decision: decision.decision,
      expectedDecision: input.expectedDecision,
      reason: decision.reason,
      riskLevel: decision.riskLevel,
      userAuthorization: decision.userAuthorization,
    };

    if (decision.decision !== input.expectedDecision) {
      throw new Error(
        `Guardian decided ${decision.decision} (risk=${decision.riskLevel}, auth=${decision.userAuthorization}): ${decision.reason}; expected ${input.expectedDecision}`,
      );
    }

    return {
      output,
      events: [
        {
          type: "message",
          role: "user",
          content: [
            `Expected decision: ${input.expectedDecision}`,
            `Tool: ${input.proposal.tool.name}`,
            `User intent: ${input.proposal.context.userIntent}`,
            `Input: ${JSON.stringify(input.proposal.input)}`,
          ].join("\n"),
        },
        {
          type: "message",
          role: "assistant",
          content: [
            `Decision: ${decision.decision}`,
            `Risk: ${decision.riskLevel}`,
            `Authorization: ${decision.userAuthorization}`,
            `Reason: ${decision.reason}`,
          ].join("\n"),
        },
      ],
      usage: {
        provider: "vercel-ai-gateway",
        model: resolveGuardianModelId(),
        ...(decision.costUsd !== undefined
          ? { metadata: { costUsd: decision.costUsd } }
          : {}),
      },
    };
  },
});

/** Shared vitest-evals suite options for isolated Guardian decision evals. */
export const guardianEvals = {
  harness: guardianHarness,
  // Exact decision match is asserted in the harness; no rubric judge.
  judges: [],
  judgeThreshold: null,
} satisfies DescribeEvalOptions<
  GuardianEvalInput,
  GuardianEvalOutput,
  typeof guardianHarness
>;
