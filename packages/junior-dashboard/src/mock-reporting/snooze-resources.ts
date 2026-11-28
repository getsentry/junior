/** The Event resources of mock pages, which a mock snooze can wait on. */
import type {
  InboxSnoozeCreateBody,
  InboxViewerSnooze,
} from "@sentry/junior/api/schema";

// How the GitHub plugin says each Event reads after its page's name.
const PHRASES: Record<string, string> = {
  "issue.closed": "is closed",
  "issue.comment.created": "gets a new comment",
  "issue.opened": "is opened",
  "issue.reopened": "is reopened",
  "pull_request.checks.failed": "fails its checks",
  "pull_request.checks.passed": "passes its checks",
  "pull_request.checks.recovered": "passes its checks again",
  "pull_request.closed_unmerged": "is closed without merging",
  "pull_request.comment.created": "gets a new comment",
  "pull_request.converted_to_draft": "is converted to a draft",
  "pull_request.merge_conflict": "gets a merge conflict",
  "pull_request.merge_conflict.resolved": "no longer has a merge conflict",
  "pull_request.merged": "is merged",
  "pull_request.opened": "is opened",
  "pull_request.ready_for_review": "is ready for review",
  "pull_request.reopened": "is reopened",
  "pull_request.review.approved": "is approved",
  "pull_request.review.changes_requested": "gets changes requested",
  "pull_request.review.commented": "gets a review comment",
  "pull_request.review_comment.created": "gets an inline review comment",
  "pull_request.review_requested": "gets a review request",
  "pull_request.synchronized": "gets new commits",
};

// The Events of a GitHub pull request, as the API lists them.
export const PULL_REQUEST_RESOURCE = {
  events: [
    "pull_request.checks.failed",
    "pull_request.checks.passed",
    "pull_request.checks.recovered",
    "pull_request.comment.created",
    "pull_request.opened",
    "pull_request.reopened",
    "pull_request.ready_for_review",
    "pull_request.converted_to_draft",
    "pull_request.synchronized",
    "pull_request.review_requested",
    "pull_request.review.approved",
    "pull_request.review.changes_requested",
    "pull_request.review.commented",
    "pull_request.review_comment.created",
    "pull_request.merged",
    "pull_request.closed_unmerged",
    "pull_request.merge_conflict",
    "pull_request.merge_conflict.resolved",
  ],
  namespace: "github",
  phrases: PHRASES,
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
  phrases: PHRASES,
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

// A GitHub page's Event resource, such as `getsentry/junior#12`, as the
// GitHub plugin names it.
function resourceName(url: string): string {
  const [owner, repo, , number] =
    URL.parse(url)?.pathname.split("/").slice(1) ?? [];
  return owner && repo && number ? `${owner}/${repo}#${number}` : url;
}

/**
 * A mock snooze as its viewer reads it, like the API's `snoozedByViewer`.
 * An Event without a page waits on the item's subject at `subjectUrl`.
 */
export function mockViewerSnooze(
  body: Pick<InboxSnoozeCreateBody, "triggers" | "untilClosed" | "wakeAt">,
  subjectUrl: string | undefined,
  nowMs: number,
): InboxViewerSnooze {
  const events = (body.triggers ?? []).flatMap((trigger) => {
    const url = trigger.resourceUrl ?? subjectUrl;
    if (!url) return [];
    const phrase = PHRASES[trigger.eventType];
    return [
      {
        eventType: trigger.eventType,
        outcome: trigger.outcome,
        resource: resourceName(url),
        ...(phrase ? { phrase } : undefined),
      },
    ];
  });
  return {
    snoozedAt: new Date(nowMs).toISOString(),
    ...(body.untilClosed ? { untilClosed: true as const } : undefined),
    ...(body.wakeAt ? { wakeAt: body.wakeAt } : undefined),
    ...(events.length > 0 ? { events } : undefined),
  };
}
