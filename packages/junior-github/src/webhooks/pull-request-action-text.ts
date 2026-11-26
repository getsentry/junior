import type { GitHubPullRequestAction } from "../db/schema.js";
import type { GitHubReviewAskReason } from "../pull-request-review-again.js";
import type { GitHubPullRequestMergeState } from "./installation-requests.js";

// The Inbox text for the next action of a pull request that Junior opened
// (`pull-request-action.ts`): the item body, and why the item closes.

type CloseReason = { reason: string; status: "done" | "dismissed" };

export type EndedState = Exclude<GitHubPullRequestMergeState["state"], "open">;

/** Why an item closes when its pull request is no longer open. */
export const ENDED_REASONS: Record<EndedState, CloseReason> = {
  closed: {
    reason: "The pull request closed without merging.",
    status: "dismissed",
  },
  merged: { reason: "The pull request merged.", status: "done" },
};

/** Why an item closes, when its pull request is no longer open. */
export function endedReason(
  state: GitHubPullRequestMergeState["state"],
): CloseReason | undefined {
  return state === "open" ? undefined : ENDED_REASONS[state];
}

/** Why the item of a pull request whose next action ended closes. */
export function closeReason(
  state: GitHubPullRequestMergeState,
  previous: GitHubPullRequestAction,
  mergeAccess: boolean | undefined,
): CloseReason {
  const ended = endedReason(state.state);
  if (ended) return ended;
  if (previous !== "merge") {
    return { reason: "The review request ended.", status: "done" };
  }
  if (state.autoMerge) {
    return { reason: "Auto-merge is on.", status: "dismissed" };
  }
  if (mergeAccess === false) {
    return {
      reason: "Only a person with write access can merge it.",
      status: "dismissed",
    };
  }
  return {
    reason: "The pull request is no longer ready to merge.",
    status: "dismissed",
  };
}

/** The item text that says why Junior asked for the review again. */
const REVIEW_AGAIN_TEXT: Record<GitHubReviewAskReason, string> = {
  checks: "Checks now pass, and every comment is handled.",
  handled: "Every comment on your review is handled.",
  question: "A comment asks you a question.",
};

/** The item text for a pull request's next action. */
export function actionText(
  action: GitHubPullRequestAction,
  number: number,
  reason: GitHubReviewAskReason | undefined,
  state: GitHubPullRequestMergeState,
): string {
  if (action === "merge") {
    // The text stays true when someone approves later, because the item
    // changes only when the action changes.
    return state.reviewOutcome === "approved"
      ? `#${number} is approved, and GitHub says that it can merge.`
      : `GitHub says that #${number} can merge with no review. Review it, then merge it.`;
  }
  const asked = reason ? REVIEW_AGAIN_TEXT[reason] : undefined;
  if (action === "review") {
    return asked ?? `GitHub asks you to review #${number}.`;
  }
  if (action === "mark_ready") {
    return `You approved #${number}. Mark it ready for review.`;
  }
  const step = `#${number} is a draft. Review it, then mark it ready for review.`;
  return asked ? `${asked} ${step}` : step;
}
