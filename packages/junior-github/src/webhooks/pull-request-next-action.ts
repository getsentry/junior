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
 * commented or reviewed, and when they last removed their own review
 * request. A comment-only review neither approves nor requests changes, so
 * `actedAt` leaves it out and `commentedAt` holds it. `decidedAt` holds
 * only the reviews that answer an ask.
 */
export interface LatestActivity {
  actedAt?: Date;
  askedAt?: Date;
  commentedAt?: Date;
  decidedAt?: Date;
  removedAt?: Date;
  requesterAt?: Date;
}

/** Read the requester's latest activity from a pull request's activity. */
export function latestActivity(
  activity: GitHubPullRequestActivity[],
  requesterLogin: string | undefined,
): LatestActivity {
  const latest: LatestActivity = {};
  const keep = (key: keyof LatestActivity, at: Date) => {
    const saved = latest[key];
    if (!saved || at > saved) latest[key] = at;
  };
  for (const entry of activity) {
    if (!sameLogin(entry.login, requesterLogin)) continue;
    if (entry.kind === "reviewRequest") keep("askedAt", entry.at);
    else if (entry.kind === "reviewRequestRemoved") keep("removedAt", entry.at);
    else {
      keep("requesterAt", entry.at);
      keep(entry.review === "COMMENTED" ? "commentedAt" : "actedAt", entry.at);
      if (entry.review && entry.review !== "COMMENTED") {
        keep("decidedAt", entry.at);
      }
    }
  }
  return latest;
}

/**
 * Whether the requester's review ask stays open after GitHub dropped it. A
 * comment-only review is neither yes nor no, so it does not answer the ask,
 * though GitHub drops the request on any review. An approval, a change
 * request, or the requester removing their own request ends the ask.
 */
export function askStaysOpen(activity: LatestActivity): boolean {
  const askedAt = timeOf(activity.askedAt);
  return (
    activity.askedAt !== undefined &&
    timeOf(activity.commentedAt) > askedAt &&
    timeOf(activity.decidedAt) < askedAt &&
    timeOf(activity.removedAt) < askedAt
  );
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
    askOpen: boolean;
    login: string | undefined;
  },
  saved: GitHubPullRequestAction | undefined,
): { action?: GitHubPullRequestAction } | undefined {
  if (state.state !== "open") return {};
  // With auto-merge on, GitHub merges it, so no person needs to. A pending
  // review request comes first, even where GitHub requires no review. So
  // does a review ask that a comment-only review keeps open.
  const canMerge =
    !state.draft &&
    !state.autoMerge &&
    !state.reviewPending &&
    !requester.askOpen;
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
  const requested = isRequested(state, requester.login) || requester.askOpen;
  // A reply to the change request ends the review that Junior asked for,
  // though GitHub still asks for it, because Junior acts next.
  if (requested && (!requester.actedLast || !state.changesRequested)) {
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
 * not a draft, and auto-merge is off. No review ask for the requester is
 * open, on GitHub or kept open by a comment-only review. The requester has
 * not commented or reviewed since the last push, other than a comment-only
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
    !askStaysOpen(activity) &&
    !state.changesRequested &&
    timeOf(activity.removedAt) <= timeOf(activity.askedAt) &&
    timeOf(activity.actedAt) <= timeOf(state.headCommittedAt) &&
    state.reviewOutcome === undefined
  );
}
