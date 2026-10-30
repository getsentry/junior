/**
 * Deterministic pull request merge policy enforced before Junior merges.
 *
 * The rule is "two parties, one of them human": Junior never merges code that
 * only Junior wrote and checked.
 *
 * - A pull request that Junior authored needs a current human approval.
 * - A pull request that a human authored needs a current Junior review, and
 *   Junior must not have written any of its commits.
 *
 * In both cases the requester must have write access to the repository, the
 * head commit must be the one the caller checked, no reviewer may have an open
 * change request, and GitHub must report the pull request as clean.
 */

/** Repository roles that may ask Junior to merge. */
const MERGE_REQUESTER_PERMISSIONS = new Set(["admin", "write"]);

/** Mergeable states where GitHub reports passing checks and no conflicts. */
const MERGEABLE_STATES = new Set(["clean", "has_hooks"]);

/** GitHub account fields used by the merge policy. */
export interface GitHubMergeAccount {
  id: number;
  type: string;
}

/** Pull request facts used by the merge policy. */
export interface GitHubMergePullRequest {
  author: GitHubMergeAccount | null;
  draft: boolean;
  headSha: string;
  merged: boolean;
  mergeableState: string | undefined;
  state: string;
}

/** One submitted pull request review. */
export interface GitHubMergeReview {
  commitId: string | null;
  reviewer: GitHubMergeAccount | null;
  state: string;
}

/** One pull request commit, reduced to its GitHub and Git identities. */
export interface GitHubMergeCommit {
  authorEmail: string | undefined;
  authorId: number | undefined;
  committerEmail: string | undefined;
  committerId: number | undefined;
}

/**
 * Return why Junior must not merge this pull request, or undefined when every
 * merge rule passes.
 */
export function gitHubPullRequestMergeDenial(input: {
  botEmail: string;
  botUserId: number;
  commits: readonly GitHubMergeCommit[];
  expectedHeadSha: string;
  pullRequest: GitHubMergePullRequest;
  requesterPermission: string | undefined;
  reviews: readonly GitHubMergeReview[];
}): string | undefined {
  const { pullRequest } = input;
  if (
    !input.requesterPermission ||
    !MERGE_REQUESTER_PERMISSIONS.has(input.requesterPermission)
  ) {
    return "The requester must have write access to the repository to ask for a merge.";
  }
  if (pullRequest.merged || pullRequest.state !== "open") {
    return "The pull request is not open.";
  }
  if (pullRequest.draft) {
    return "The pull request is a draft.";
  }
  const headSha = pullRequest.headSha.toLowerCase();
  if (headSha !== input.expectedHeadSha.toLowerCase()) {
    return `The pull request head is ${headSha}, not the checked commit ${input.expectedHeadSha}. Check the new commits before you merge.`;
  }
  if (!pullRequest.mergeableState || pullRequest.mergeableState === "unknown") {
    return "GitHub has not computed whether the pull request can merge yet. Try again shortly.";
  }
  if (!MERGEABLE_STATES.has(pullRequest.mergeableState)) {
    return `GitHub reports the pull request as \`${pullRequest.mergeableState}\`. It must have passing checks, no conflicts, and no unmet branch protection.`;
  }

  const latestReviews = latestReviewByReviewer(input.reviews);
  if (latestReviews.some((review) => review.state === "CHANGES_REQUESTED")) {
    return "A reviewer has requested changes.";
  }

  const isBot = (account: GitHubMergeAccount | null) =>
    account?.id === input.botUserId;
  const isHuman = (account: GitHubMergeAccount | null) =>
    account?.type === "User" && !isBot(account);
  const isCurrent = (review: GitHubMergeReview) =>
    review.commitId?.toLowerCase() === headSha;

  if (isBot(pullRequest.author)) {
    const approved = latestReviews.some(
      (review) =>
        review.state === "APPROVED" &&
        isHuman(review.reviewer) &&
        isCurrent(review),
    );
    return approved
      ? undefined
      : "You authored this pull request, so a person must approve its current head commit.";
  }

  if (!isHuman(pullRequest.author)) {
    return "You only merge pull requests that you or a person authored.";
  }
  const botEmail = input.botEmail.toLowerCase();
  const botWroteCommit = input.commits.some(
    (commit) =>
      commit.authorId === input.botUserId ||
      commit.committerId === input.botUserId ||
      commit.authorEmail?.toLowerCase() === botEmail ||
      commit.committerEmail?.toLowerCase() === botEmail,
  );
  if (botWroteCommit) {
    return "You wrote commits on this pull request. You only merge a pull request that a person authored when a person wrote all of its commits.";
  }
  const reviewed = input.reviews.some(
    (review) => isBot(review.reviewer) && isCurrent(review),
  );
  return reviewed
    ? undefined
    : "Submit your review on the current head commit before you merge a pull request that a person authored.";
}

/** Keep each reviewer's latest decisive review, as GitHub does for merges. */
function latestReviewByReviewer(
  reviews: readonly GitHubMergeReview[],
): GitHubMergeReview[] {
  const latest = new Map<number, GitHubMergeReview>();
  for (const review of reviews) {
    if (!review.reviewer) continue;
    if (review.state === "DISMISSED") {
      latest.delete(review.reviewer.id);
      continue;
    }
    if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED") {
      continue;
    }
    latest.set(review.reviewer.id, review);
  }
  return [...latest.values()];
}
