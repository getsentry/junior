/**
 * The current Guardian behind the `Guardian` interface.
 *
 * It sends each proposal to the model reviewer and returns the reviewer's
 * decision unchanged. It reads none of the request's facts, because it
 * judges only the proposal. A review that cannot run stops the Run.
 */
import { mapBounded } from "@/chat/fan-out";
import type { Guardian, GuardianActionResult } from "@/chat/guardian/guardian";
import type { ToolActionReviewer } from "@/chat/guardian/proposal";

/** Most reviews of one batch that run at the same time. */
const MAX_CONCURRENT_REVIEWS = 4;

/** Create the current Guardian over one model reviewer. */
export function createCurrentGuardian(reviewer: ToolActionReviewer): Guardian {
  return {
    onUnavailable: "stop-run",
    async review(request, { signal }) {
      const actions = await mapBounded(
        request.actions,
        async (proposal): Promise<GuardianActionResult> => {
          try {
            const decision = await reviewer.review(
              proposal,
              signal ? { signal } : {},
            );
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
      // Each ask is its own text to the agent, and nothing groups them, so
      // each becomes its own Inbox item.
      return {
        actions,
        inboxItems: actions.filter((action) => action.outcome === "ask").length,
      };
    },
  };
}
