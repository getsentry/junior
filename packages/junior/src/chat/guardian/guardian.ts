/**
 * The interface between the tool gate and one Guardian implementation.
 *
 * The gate builds a proposal for each action that needs review and asks the
 * selected Guardian for an outcome for each one. The current Guardian and
 * its replacement both implement `Guardian`, and the Guardian design evals
 * measure either one through it.
 */
import type {
  ToolActionDecision,
  ToolActionProposal,
  ToolActionReviewDecision,
} from "@/chat/guardian/proposal";

/**
 * Facts that core gives Guardian in addition to the proposal
 * (`facts-from-junior` in `design/guardian.md`). An implementation ignores
 * the facts that it does not use.
 */
export interface GuardianFacts {
  /**
   * Lines of the person whose instruction the action serves that reach this
   * Turn from somewhere else: from the Turn that started the work
   * (`instruction`), or as a message from the person's linked account. A
   * Conversation that an agent started or messaged gets none: its brief is
   * its instruction (`brief-is-instruction`).
   */
  personLines?: Array<{
    text: string;
    via: "instruction" | "linked-account";
  }>;
  /** Exact actions that the person confirmed in an Inbox item. */
  confirmed?: Array<{ tool: string; input: Record<string, unknown> }>;
  /** Resources that the same instruction created, such as a pull request. */
  createdByInstruction?: string[];
  /**
   * Who can read the destination of the action (`facts-from-junior`):
   * people of the organization only, or anyone.
   */
  destinationReaders?: "organization" | "anyone";
}

/** One action, or the calls of one Code Mode batch, for Guardian. */
export interface GuardianRequest {
  /** One action, or each call of one Code Mode batch, in order. */
  actions: ToolActionProposal[];
  facts?: GuardianFacts;
}

/**
 * Outcome for one action. `guardian` carries the reviewer's decision.
 * `person` is an allow on the person's confirmation of the exact action,
 * with no review. `unavailable` is a review that could not run.
 */
export type GuardianActionResult =
  | {
      decidedBy: "guardian";
      decision: ToolActionReviewDecision;
      outcome: ToolActionDecision;
    }
  | { decidedBy: "person"; outcome: "allow"; reason: string }
  | { error: unknown; outcome: "unavailable" };

/** What Guardian did with one request. */
export interface GuardianResult {
  /** One entry for each action of the request, in order. */
  actions: GuardianActionResult[];
  /**
   * Inbox items that the asks of the request need. The gate does not file
   * them: the agent asks from the tool error.
   */
  inboxItems: number;
}

/** One Guardian implementation. */
export interface Guardian {
  /**
   * What a review that cannot run does. `stop-run` stops the whole Run.
   * `fail-action` fails only that action, and the agent may retry it once
   * (`bounded-failure`).
   */
  onUnavailable: "stop-run" | "fail-action";
  review(
    request: GuardianRequest,
    options: { signal?: AbortSignal | undefined },
  ): Promise<GuardianResult>;
}
