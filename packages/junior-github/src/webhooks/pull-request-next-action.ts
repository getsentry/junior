/**
 * Derive a Junior pull request's next action, and whether it is in limbo,
 * from one GitHub read. `pull-request-action.ts` states the rules and acts
 * on the result.
 */
import type { GitHubPullRequestAction } from "../db/schema.js";
import type {
  GitHubPullRequestActivity,
  GitHubPullRequestMergeState,
} from "./installation-requests.js";
import {
  decide,
  type Inputs,
  type Outcome,
} from "./pull-request-kind.generated.js";

/** Whether two GitHub logins name the same account. */
export function sameLogin(a: string, b: string | undefined): boolean {
  return b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * When GitHub last asked the requester for a review, when the requester last
 * commented or reviewed, their latest submitted review and their latest
 * review that is not comment-only, and when they last removed their own
 * review request. `actedAt` leaves out a comment-only
 * review, which neither approves nor requests changes.
 */
export interface LatestActivity {
  actedAt?: Date;
  askedAt?: Date;
  decided?: { at: Date; state: string };
  removedAt?: Date;
  requesterAt?: Date;
  review?: { at: Date; state: string };
}

/** Read the requester's latest activity from a pull request's activity. */
export function latestActivity(
  activity: GitHubPullRequestActivity[],
  requesterLogin: string | undefined,
): LatestActivity {
  const latest: LatestActivity = {};
  const keep = (
    key: Exclude<keyof LatestActivity, "decided" | "review">,
    at: Date,
  ) => {
    const saved = latest[key];
    if (!saved || at > saved) latest[key] = at;
  };
  for (const entry of activity) {
    if (!sameLogin(entry.login, requesterLogin)) continue;
    if (entry.kind === "reviewRequest") keep("askedAt", entry.at);
    else if (entry.kind === "reviewRequestRemoved") keep("removedAt", entry.at);
    else {
      keep("requesterAt", entry.at);
      if (entry.review !== "COMMENTED") keep("actedAt", entry.at);
      const review = entry.review && { at: entry.at, state: entry.review };
      if (review && (!latest.review || review.at > latest.review.at)) {
        latest.review = review;
      }
      if (
        review &&
        review.state !== "COMMENTED" &&
        (!latest.decided || review.at > latest.decided.at)
      ) {
        latest.decided = review;
      }
    }
  }
  return latest;
}

/**
 * Whether the requester's latest review waits for Junior's answer: a change
 * request, or a comment-only review, which Junior handles like a change
 * request. After the requester approves, only a comment-only review after
 * a later ask counts, so a comment on an approved pull request leaves it
 * ready to merge. A dismissed review, such as an approval that a push
 * reset, works the same way: a comment since it waits for a new ask, so a
 * ready pull request is in limbo and Junior asks. A draft cannot merge, so
 * it is left out.
 */
export function requesterFeedback(
  state: GitHubPullRequestMergeState,
  activity: LatestActivity,
): boolean {
  const { decided, review } = activity;
  if (state.draft || !review) return false;
  if (review.state === "CHANGES_REQUESTED") return true;
  if (review.state !== "COMMENTED") return false;
  if (decided?.state !== "APPROVED" && decided?.state !== "DISMISSED") {
    return true;
  }
  const askedAt = timeOf(activity.askedAt);
  return askedAt > decided.at.getTime() && review.at.getTime() > askedAt;
}

/** A time in milliseconds. A missing time is older than every time. */
export function timeOf(at: Date | undefined): number {
  return at ? at.getTime() : Number.NEGATIVE_INFINITY;
}

/**
 * GitHub's merge state as the table's input. Every state but `clean` and
 * `dirty`, such as `blocked`, `behind`, or `unstable`, keeps the merge from
 * being the requester's next action.
 */
function mergeStateInput(
  mergeableState: string | undefined,
): Inputs["merge_state"] {
  if (!mergeableState) return "unknown";
  if (mergeableState === "clean") return "clean";
  return mergeableState === "dirty" ? "conflict" : "blocked";
}

/** GitHub's review outcome as the table's input. */
const REVIEW_OUTCOMES: Record<
  NonNullable<GitHubPullRequestMergeState["reviewOutcome"]> | "none",
  Inputs["review_outcome"]
> = {
  approved: "approved",
  changesRequested: "changes_requested",
  none: "none",
};

type Ask = Extract<Outcome, { kind: "ask" }>;

/** The action of an ask that names a step, by its step. */
const STEP_ACTIONS: Record<
  NonNullable<Extract<Ask, { step: string }>["step"]>,
  GitHubPullRequestAction
> = {
  "to mark it ready for review": "mark_ready",
  "to review it, then mark it ready for review": "review_draft",
};

function askAction(ask: Ask): GitHubPullRequestAction {
  if ("step" in ask) return STEP_ACTIONS[ask.step];
  return ask.label === "Ready to merge" ? "merge" : "review";
}

/** The repository roles that GitHub lets merge a pull request. */
const MERGE_ROLES = new Set(["admin", "maintain", "write"]);

/** Whether a repository role from `loadRepositoryRole` can merge. */
export function canMergeRole(role: string): boolean {
  return MERGE_ROLES.has(role.toLowerCase());
}

/**
 * Derive the requester's next action from the rules in
 * `pull-request-kind.yaml`. Return undefined when it cannot be known yet,
 * so a later event decides.
 */
export function nextAction(
  state: GitHubPullRequestMergeState,
  requester: {
    actedLast: boolean;
    askedAgain: boolean;
    /** `canMergeRole`: the requester's repository role can merge. */
    canMerge: boolean;
    /** `requesterFeedback`: the requester waits for Junior's answer. */
    feedback: boolean;
    login: string | undefined;
  },
  saved: GitHubPullRequestAction | undefined,
): { action?: GitHubPullRequestAction } | undefined {
  // The item serves only the requester, so the requester is the viewer.
  // `requestedReviewers` is never set without `reviewPending`, and
  // `requesterFeedback` is false for a draft.
  const outcome = decide({
    auto_merge: state.autoMerge,
    draft: state.draft,
    merge_state: mergeStateInput(state.mergeableState),
    review_outcome: REVIEW_OUTCOMES[state.reviewOutcome ?? "none"],
    review_pending: state.reviewPending,
    state: state.state,
    viewer: {
      approved: state.requesterApproved,
      asked_again: requester.askedAgain,
      can_merge: requester.canMerge,
      feedback: requester.feedback,
      replied: requester.actedLast,
      requested: isRequested(state, requester.login),
      requester: true,
      shown: saved ?? "nothing",
    },
  });
  if (outcome.kind === "keep") return undefined;
  return outcome.kind === "ask" ? { action: askAction(outcome) } : {};
}

function isRequested(
  state: GitHubPullRequestMergeState,
  login: string | undefined,
): boolean {
  const lower = login?.toLowerCase();
  return state.requestedReviewers.some(
    (reviewer) => reviewer.toLowerCase() === lower,
  );
}

/**
 * Whether a pull request whose action is none is in limbo: it waits on
 * nobody, so Junior asks for the requester's review on GitHub. It is open,
 * not a draft, and auto-merge is off. GitHub does not ask the requester
 * for a review, and the requester's feedback does not wait for Junior. The
 * requester has not reviewed since the last push, other than a comment-only
 * review. No reviewer approved it, so it does not wait only on others, and
 * no reviewer requests changes, so Junior does not act next. Junior does
 * not ask when the requester removed their own review request and no one
 * asked them since.
 */
export function inLimbo(
  state: GitHubPullRequestMergeState,
  activity: LatestActivity,
  login: string,
): boolean {
  return (
    state.state === "open" &&
    !state.draft &&
    !state.autoMerge &&
    !isRequested(state, login) &&
    !requesterFeedback(state, activity) &&
    timeOf(activity.removedAt) <= timeOf(activity.askedAt) &&
    timeOf(activity.actedAt) <= timeOf(state.headCommittedAt) &&
    state.reviewOutcome === undefined
  );
}
