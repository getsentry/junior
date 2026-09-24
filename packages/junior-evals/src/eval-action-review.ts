import type { ToolActionReviewer } from "@/chat/tool-support/action-review";

/**
 * Deterministic reviewer that allows every proposed action.
 *
 * Integration cases assert runtime wiring, not Guardian judgement. A live
 * Guardian asks for confirmation on some ordinary requests, which fails a
 * hard pass/fail case for a reason `evals/guardian/**` already owns.
 */
export const allowAllActionReviewer: ToolActionReviewer = {
  async review() {
    return {
      decision: "allow",
      reason: "Eval suite runs with deterministic action review",
      riskLevel: "low",
      userAuthorization: "high",
    };
  },
};

/** Return the reviewer the suite config selected, or undefined for Guardian. */
export function evalActionReviewer(): ToolActionReviewer | undefined {
  const mode = process.env.EVAL_ACTION_REVIEW?.trim();
  if (!mode) return undefined;
  if (mode === "allow") return allowAllActionReviewer;
  throw new Error(
    `EVAL_ACTION_REVIEW must be unset or "allow", got ${JSON.stringify(mode)}`,
  );
}
