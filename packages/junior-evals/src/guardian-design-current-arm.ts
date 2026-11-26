/**
 * The current Guardian as a `GuardianArm`.
 *
 * It sends each proposal that the gate reviews to the production reviewer, as
 * the gate does today, and reports what today's runtime does with the result. It reads none of
 * the design facts of a request, because today's core does not send them.
 */
import { completeObject } from "@/chat/core-model";
import { mapBounded } from "@/chat/fan-out";
import { guardianPluginFacts } from "@/chat/guardian/policy";
import { createGuardianActionReviewer } from "@/chat/guardian/reviewer";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { ProviderError } from "@/chat/services/provider-error";
import type {
  GuardianArm,
  GuardianDesignResult,
} from "./guardian-design-harness";
import { reviewGuardianProposal } from "./guardian-harness";
import { gateReviews } from "./guardian-tools";

// A model that the AI Gateway does not serve, so each review call fails as
// it does in a provider outage.
const UNAVAILABLE_MODEL_ID = "junior-evals/unavailable-model";

/** Review each action of a request with today's reviewer. */
export const currentGuardianArm: GuardianArm = async (request, { signal }) => {
  // The facts that production gives for the installed plugins.
  const destinationFacts = guardianPluginFacts(
    pluginCatalogRuntime.getProviders().map(({ manifest }) => manifest),
  );
  const reviewer = request.reviewUnavailable
    ? createGuardianActionReviewer({
        completeObject,
        modelId: UNAVAILABLE_MODEL_ID,
      })
    : undefined;
  // A call that the gate does not send to Guardian runs.
  const reviewed = await mapBounded(request.actions, (proposal) =>
    gateReviews(proposal.tool, proposal.input),
  );
  // The gate reviews the calls of a batch at once, then settles them in order.
  const reviews = await Promise.allSettled(
    request.actions.map((proposal, index) =>
      !reviewed[index]
        ? Promise.resolve(undefined)
        : reviewer
          ? reviewer.review(proposal, { signal })
          : reviewGuardianProposal(proposal, { destinationFacts, signal }),
    ),
  );
  const actions: GuardianDesignResult["actions"] = [];
  for (const review of reviews) {
    if (review.status === "rejected") {
      // A provider failure that the case did not ask for is a broken eval
      // run, not an outcome of the case.
      if (
        signal.aborted ||
        (review.reason instanceof ProviderError && !request.reviewUnavailable)
      ) {
        throw review.reason;
      }
      // Today's gate turns each review error into an unavailable review and
      // calls `onFatal`, which aborts the agent (`gate.ts` settle). The rest
      // of the Run does not happen.
      actions.push({ outcome: "run-stopped" });
      return { actions, inboxItems: 0 };
    }
    const decision = review.value;
    if (!decision) {
      actions.push({ decidedBy: "rule", outcome: "allow" });
      continue;
    }
    actions.push({
      decidedBy: "guardian",
      outcome: decision.decision,
      reason: decision.reason,
      ...(decision.rule ? { rule: decision.rule } : undefined),
    });
  }
  // Each ask is its own text to the agent, and nothing groups them, so each
  // becomes its own Inbox item.
  return {
    actions,
    inboxItems: actions.filter((action) => action.outcome === "ask").length,
  };
};
