/**
 * Arms of the Guardian design suite over the `Guardian` interface.
 *
 * An arm sends the actions that the gate reviews to one Guardian, in one
 * request, as the gate does, and reports what the gate does with each
 * decision. A call that the gate does not review runs.
 */
import { completeObject } from "@/chat/core-model";
import { createAgentGuardian } from "@/chat/guardian/agent/guardian";
import { mapBounded } from "@/chat/fan-out";
import { createCurrentGuardian } from "@/chat/guardian/current";
import { AGENT_REVIEWED_TOOLS, type GuardianBatch } from "@/chat/guardian/gate";
import type { Guardian, Review } from "@/chat/guardian/guardian";
import {
  guardianPluginFacts,
  type GuardianDestinationFact,
} from "@/chat/guardian/policy";
import { createGuardianActionReviewer } from "@/chat/guardian/reviewer";
import { getAppContext } from "@/app/context";
import { ProviderError } from "@/chat/services/provider-error";
import type {
  GuardianArm,
  GuardianDesignResult,
} from "./guardian-design-harness";
import {
  designGuardianRequest,
  withPersonLines,
} from "./guardian-design-request";
import { resolveGuardianModelId } from "./guardian-harness";
import { gateReviews } from "./guardian-tools";

// A model that the AI Gateway does not serve, so each review call fails as
// it does in a provider outage.
const UNAVAILABLE_MODEL_ID = "junior-evals/unavailable-model";

/** The review model of one request. */
function armModelId(reviewUnavailable: boolean | undefined): string {
  return reviewUnavailable ? UNAVAILABLE_MODEL_ID : resolveGuardianModelId();
}

/** The facts that production gives for the installed plugins. */
export function installedPluginFacts() {
  return guardianPluginFacts(
    getAppContext()
      .catalog.getProviders()
      .map(({ manifest }) => manifest),
  );
}

/**
 * Make an arm that reviews each request with the Guardian of its model.
 * `agentReviews` is true for the agent Guardian: only it reviews
 * `AGENT_REVIEWED_TOOLS` and reads a Watch creator's lines. Under the current
 * Guardian, production runs those tools with no review (`gate.ts`).
 */
export function guardianArm(
  guardian: (
    modelId: string,
    batch: GuardianBatch,
    destinationFacts: GuardianDestinationFact[],
  ) => Guardian,
  { agentReviews }: { agentReviews: boolean },
): GuardianArm {
  return async (request, { signal }) => {
    const reviewed = await mapBounded(request.actions, async (proposal) =>
      AGENT_REVIEWED_TOOLS.has(proposal.tool.name)
        ? agentReviews
        : await gateReviews(proposal),
    );
    const indexes = request.actions.flatMap((_, index) =>
      reviewed[index] ? [index] : [],
    );
    let reviews: Review[] | undefined = [];
    if (indexes.length > 0) {
      const proposals = indexes.map((index) =>
        withPersonLines(request.actions[index]!, request.facts, agentReviews),
      );
      const batch: GuardianBatch = { proposals };
      try {
        reviews = await guardian(
          armModelId(request.reviewUnavailable),
          batch,
          request.destinationFacts ?? installedPluginFacts(),
        ).review(await designGuardianRequest(proposals, request.facts), signal);
      } catch (error) {
        // A provider failure that the case did not ask for is a broken eval
        // run, not an outcome of the case.
        if (
          signal.aborted ||
          (error instanceof ProviderError && !request.reviewUnavailable)
        ) {
          throw error;
        }
        // The gate fails only the actions of the batch.
        reviews = undefined;
      }
    }
    let next = 0;
    const actions: GuardianDesignResult["actions"] = reviewed.map(
      (needsReview) => {
        if (!needsReview) {
          return { outcome: "allow" };
        }
        if (!reviews) {
          return { outcome: "unavailable" };
        }
        const review = reviews[next++];
        if (!review) {
          throw new Error("A reviewed action has no Guardian review.");
        }
        return {
          outcome: review.decision,
          reason: review.reason,
          ...(review.rule ? { rule: review.rule } : undefined),
        };
      },
    );
    return { actions };
  };
}

/** The current Guardian. */
export const currentGuardianArm = guardianArm(
  (modelId, batch, destinationFacts) =>
    createCurrentGuardian(
      createGuardianActionReviewer({
        completeObject,
        destinationFacts,
        modelId,
      }),
      batch,
    ),
  { agentReviews: false },
);

/** The agent Guardian (`guardian-agent`), reported as the next Guardian. */
export const agentGuardianArm = guardianArm(
  (modelId, batch, destinationFacts) =>
    createAgentGuardian(
      {
        completeObject,
        destinationFacts,
        modelId,
      },
      batch,
    ),
  { agentReviews: true },
);

/** The agent Guardian with every reviewed action sent to its review step. */
export const agentOneStepGuardianArm = guardianArm(
  (modelId, batch, destinationFacts) =>
    createAgentGuardian(
      {
        completeObject,
        destinationFacts,
        modelId,
        screen: false,
      },
      batch,
    ),
  { agentReviews: true },
);
