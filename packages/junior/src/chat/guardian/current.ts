/**
 * The current Guardian behind the `Guardian` interface. It sends each action
 * to the model reviewer with the proposal that the gate built for it. The
 * proposal holds evidence that the request does not carry, such as recent
 * tool calls and the credential, so its decisions stay the same.
 */
import { mapBounded } from "@/chat/fan-out";
import type { GuardianBatch } from "@/chat/guardian/gate";
import type { Guardian, Review, Rule } from "@/chat/guardian/guardian";
import type { GuardianBlockRuleId } from "@/chat/guardian/policy";
import type { ToolActionReviewer } from "@/chat/guardian/proposal";

/** Most reviews of one batch that run at the same time. */
const MAX_CONCURRENT_REVIEWS = 4;

/** The rule of the interface that each rule of the current policy names. */
const RULES: Record<GuardianBlockRuleId, Rule> = {
  withheld_step: "unrequested",
  unresolved_prior_ask: "unrequested",
  unclear_destination: "unrequested",
  different_change: "unrequested",
  unrequested_write: "unrequested",
  new_commitment: "unrequested",
  high_risk_low_authorization: "unrequested",
  data_exposure: "data_exposure",
  credential_probing: "credential_probing",
  security_weakening: "security_weakening",
  unrequested_destruction: "unrequested",
  untrusted_instruction: "untrusted_instruction",
  revoked_approval: "restriction",
  out_of_scope: "unrequested",
};

function isBlockRule(rule: string): rule is GuardianBlockRuleId {
  return Object.hasOwn(RULES, rule);
}

/** Create the current Guardian for one batch over one model reviewer. */
export function createCurrentGuardian(
  reviewer: ToolActionReviewer,
  batch: GuardianBatch,
): Guardian {
  return {
    async review(request, signal) {
      if (request.actions.length !== batch.proposals.length) {
        throw new Error("Each action needs the proposal that the gate built.");
      }
      return await mapBounded(
        batch.proposals,
        async (proposal): Promise<Review> => {
          const review = await reviewer.review(proposal, { signal });
          const rule =
            review.rule && isBlockRule(review.rule)
              ? RULES[review.rule]
              : undefined;
          return {
            decision: review.decision,
            ...(rule ? { rule } : undefined),
            reason: review.reason,
            ...(review.costUsd !== undefined
              ? { costUsd: review.costUsd }
              : undefined),
          };
        },
        MAX_CONCURRENT_REVIEWS,
      );
    },
  };
}
