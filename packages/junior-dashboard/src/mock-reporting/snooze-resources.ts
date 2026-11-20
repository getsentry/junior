/** The Event resources of mock pages, which a mock snooze can wait on. */

// The Events of a GitHub pull request, as the API lists them.
export const PULL_REQUEST_RESOURCE = {
  events: [
    "pull_request.checks.failed",
    "pull_request.checks.passed",
    "pull_request.checks.recovered",
    "pull_request.comment.created",
    "pull_request.opened",
    "pull_request.ready_for_review",
    "pull_request.review.approved",
    "pull_request.review.changes_requested",
    "pull_request.review.commented",
    "pull_request.review_comment.created",
    "pull_request.merged",
    "pull_request.closed_unmerged",
    "pull_request.merge_conflict",
  ],
  namespace: "github",
  resourceType: "pull_request",
};

// The Events of a GitHub issue, as the API lists them.
const ISSUE_RESOURCE = {
  events: [
    "issue.comment.created",
    "issue.opened",
    "issue.closed",
    "issue.reopened",
  ],
  namespace: "github",
  resourceType: "issue",
};

/**
 * The Events of a page that the viewer names for a snooze, like
 * `GET /api/inbox/snoozes/resource`. The viewer can see the pull requests
 * and issues of `getsentry` repositories only.
 */
export function readMockSnoozeResource(url: string) {
  const parsed = URL.parse(url);
  const [owner, , kind, number] = parsed?.pathname.split("/").slice(1) ?? [];
  if (parsed?.host !== "github.com" || owner !== "getsentry" || !number) {
    return undefined;
  }
  if (kind === "pull") return PULL_REQUEST_RESOURCE;
  return kind === "issues" ? ISSUE_RESOURCE : undefined;
}
