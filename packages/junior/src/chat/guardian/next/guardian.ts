/**
 * The next Guardian, built to `design/guardian.md`.
 *
 * Code owns the flow: an exact action that the person confirmed runs with
 * no review, an action too large to review or a review that cannot run
 * fails only that action, and each outcome comes from the model's
 * assessment through `nextGuardianOutcome`. The model judges only risk,
 * authorization, and which rule matches.
 */
import * as z from "zod";
import type { completeObject } from "@/chat/core-model";
import { mapBounded } from "@/chat/fan-out";
import { canonicalJson } from "@/chat/guardian/gate";
import type {
  Guardian,
  GuardianActionResult,
  GuardianFacts,
} from "@/chat/guardian/guardian";
import {
  NEXT_GUARDIAN_POLICY,
  NEXT_GUARDIAN_RULE_IDS,
  NEXT_GUARDIAN_RULES,
  type NextGuardianRule,
} from "@/chat/guardian/next/policy";
import { nextGuardianPrompt } from "@/chat/guardian/next/prompt";
import {
  guardianSystemPrompt,
  type GuardianDestinationFact,
} from "@/chat/guardian/policy";
import {
  RISK_LEVELS,
  USER_AUTHORIZATION_LEVELS,
  type ToolActionDecision,
  type ToolActionProposal,
  type ToolActionReviewDecision,
} from "@/chat/guardian/proposal";
import { logWarn } from "@/chat/logging";
import { ProviderError } from "@/chat/services/provider-error";

// Field order is generation order: the model rates risk and authorization
// before it names a rule, and names the rule before it says whether the
// person named what the rule needs.
const assessmentSchema = z
  .object({
    riskLevel: z.enum(RISK_LEVELS),
    userAuthorization: z.enum(USER_AUTHORIZATION_LEVELS),
    rule: z.enum(NEXT_GUARDIAN_RULE_IDS),
    named: z.boolean(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/** The model's assessment of one action. */
export type NextGuardianAssessment = z.infer<typeof assessmentSchema>;

const REVIEW_TIMEOUT_MS = 60_000;
const REVIEW_MAX_TOKENS = 2_000;
const MAX_CONCURRENT_REVIEWS = 4;

/**
 * Derive the outcome of one assessment (`rule-kinds`, `must-name`).
 *
 * - A hard rule denies.
 * - A confirmation rule asks, unless it has something to name and the
 *   person's own lines name it and authorize the action highly.
 * - With no rule, high or critical risk with low or unknown authorization
 *   asks. Everything else is allowed (`allow-default`).
 *
 * An ask stays an ask in an Automation run (`automation-ask`).
 */
export function nextGuardianOutcome(
  assessment: NextGuardianAssessment,
): ToolActionDecision {
  if (assessment.rule !== "none") {
    const rule: NextGuardianRule = NEXT_GUARDIAN_RULES[assessment.rule];
    if (rule.kind === "deny") {
      return "deny";
    }
    // A rule with nothing to name, such as a hold that nobody lifted, asks
    // until the person confirms the exact action.
    return rule.mustName &&
      assessment.named &&
      assessment.userAuthorization === "high"
      ? "allow"
      : "ask";
  }
  const highRisk =
    assessment.riskLevel === "high" || assessment.riskLevel === "critical";
  const weakAuthorization =
    assessment.userAuthorization === "low" ||
    assessment.userAuthorization === "unknown";
  return highRisk && weakAuthorization ? "ask" : "allow";
}

/**
 * True when the person confirmed this exact action: the tool that the agent
 * called and the same input (`confirmed-runs`, `confirm-follows`).
 */
function confirmedByPerson(
  proposal: ToolActionProposal,
  facts: GuardianFacts | undefined,
): boolean {
  const tool = proposal.tool.dispatcherName ?? proposal.tool.name;
  const input = JSON.stringify(canonicalJson(proposal.input));
  return (facts?.confirmed ?? []).some(
    (action) =>
      action.tool === tool &&
      JSON.stringify(canonicalJson(action.input)) === input,
  );
}

/** Create the next Guardian over one review model. */
export function createNextGuardian(options: {
  completeObject: typeof completeObject;
  /** Install-configured plugin facts about where writes go. */
  destinationFacts?: readonly GuardianDestinationFact[];
  modelId: string;
}): Guardian {
  const system = guardianSystemPrompt(
    options.destinationFacts,
    NEXT_GUARDIAN_POLICY,
  );

  const assess = async (
    proposal: ToolActionProposal,
    facts: GuardianFacts | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ToolActionReviewDecision> => {
    // Built before the model call, so an action too large to review fails
    // before any cost.
    const prompt = nextGuardianPrompt(proposal, facts);
    const timeout = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
    const reviewSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const complete = () =>
      options.completeObject({
        modelId: options.modelId,
        schema: assessmentSchema,
        system,
        prompt,
        maxTokens: REVIEW_MAX_TOKENS,
        operation: "guardian_action_review",
        // `guardian_action_reviewed` stores the cost.
        cost: { owner: "caller" },
        signal: reviewSignal,
        metadata: {
          conversationId: proposal.context.conversationId,
          guardianRole: "tool_action_review",
        },
      });
    let result;
    try {
      result = await complete();
    } catch (error) {
      if (
        reviewSignal.aborted ||
        !(error instanceof ProviderError) ||
        error.kind !== "invalid_response"
      ) {
        throw error;
      }
      logWarn("guardian.action_review.retrying", {
        "app.ai.provider_error.kind": error.kind,
        "app.guardian.review_attempt": 2,
        "gen_ai.request.model": error.modelId ?? options.modelId,
      });
      result = await complete();
    }
    const assessment = assessmentSchema.parse(result.object);
    return {
      decision: nextGuardianOutcome(assessment),
      reason: assessment.reason,
      riskLevel: assessment.riskLevel,
      rule: assessment.rule,
      userAuthorization: assessment.userAuthorization,
      ...(result.costUsd !== undefined
        ? { costUsd: result.costUsd }
        : undefined),
    };
  };

  return {
    onUnavailable: "fail-action",
    async review(request, { signal }) {
      const actions = await mapBounded(
        request.actions,
        async (proposal): Promise<GuardianActionResult> => {
          if (confirmedByPerson(proposal, request.facts)) {
            return {
              decidedBy: "person",
              outcome: "allow",
              reason: "The person confirmed this exact action.",
            };
          }
          try {
            const decision = await assess(proposal, request.facts, signal);
            return {
              decidedBy: "guardian",
              decision,
              outcome: decision.decision,
            };
          } catch (error) {
            // The caller's abort is a stop, not an unavailable review.
            if (signal?.aborted) {
              throw error;
            }
            return { error, outcome: "unavailable" };
          }
        },
        MAX_CONCURRENT_REVIEWS,
      );
      // The person gets one Inbox item for every ask of the request
      // (`one-ask-per-batch`).
      return {
        actions,
        inboxItems: actions.some((action) => action.outcome === "ask") ? 1 : 0,
      };
    },
  };
}
