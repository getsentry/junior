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
 * Derive the requester's next action. Return undefined when it cannot be
 * known yet, so a later event decides.
 */
export function nextAction(
  state: GitHubPullRequestMergeState,
  requester: {
    actedLast: boolean;
    askedAgain: boolean;
    /** `requesterFeedback`: the requester waits for Junior's answer. */
    feedback: boolean;
    login: string | undefined;
    /**
     * GitHub lets the requester merge on the repository. Without it, a
     * person with write access merges, so the requester gets no merge ask.
     */
    mergeAccess: boolean;
  },
  saved: GitHubPullRequestAction | undefined,
): { action?: GitHubPullRequestAction } | undefined {
  if (state.state !== "open") return {};
  // With auto-merge on, GitHub merges it, so no person needs to. A pending
  // review request comes first, even where GitHub requires no review. So
  // does the requester's feedback, because Junior acts next.
  const canMerge =
    requester.mergeAccess &&
    !state.draft &&
    !state.autoMerge &&
    !state.reviewPending &&
    !requester.feedback;
  if (
    canMerge &&
    state.mergeableState === "clean" &&
    state.reviewOutcome !== "changesRequested"
  ) {
    return { action: "merge" };
  }
  // GitHub has not computed the merge state yet, such as after a push. The
  // merge can still be the action, so it stays until a later event decides.
  if (canMerge && !state.mergeableState && saved === "merge") return undefined;
  const review = state.draft ? "review_draft" : "review";
  if (requester.askedAgain) return { action: review };
  // A reply to the requester's feedback ends the review that Junior asked
  // for, though GitHub still asks for it, because Junior acts next.
  if (
    isRequested(state, requester.login) &&
    (!requester.actedLast || !requester.feedback)
  ) {
    return { action: review };
  }
  // The requester approved the draft, so the step left is to mark it ready.
  if (state.draft && state.requesterApproved) return { action: "mark_ready" };
  if (canMerge && !state.mergeableState) return undefined;
  return {};
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
