import type { SubscribableResource } from "@sentry/junior-plugin-api";

const SUPPORTED_EVENTS = [
  "checks.failed",
  "checks.recovered",
  "comment.created",
  "review.approved",
  "review.changes_requested",
  "review.commented",
  "review_comment.created",
  "state.merged",
  "state.closed_unmerged",
];
const SUGGESTED_EVENTS = [
  "checks.failed",
  "comment.created",
  "review.changes_requested",
  "review.commented",
  "review_comment.created",
  "state.merged",
  "state.closed_unmerged",
];

/** Build the stable pull request identity shared by tools and webhooks. */
export function gitHubPullRequestResource(input: {
  number: number;
  repo: string;
}): Pick<SubscribableResource, "label" | "provider" | "resourceRef"> {
  return {
    label: `GitHub PR ${input.repo}#${input.number}`,
    provider: "github",
    resourceRef: `github:pull_request:${input.repo}#${input.number}`,
  };
}

/** Describe a pull request as a resource when webhook subscriptions are enabled. */
export function gitHubPullRequestSubscribable(input: {
  number: number;
  repo: string;
}): SubscribableResource | undefined {
  if (!process.env.GITHUB_WEBHOOK_SECRET?.trim()) return undefined;
  return {
    ...gitHubPullRequestResource(input),
    suggestedEvents: SUGGESTED_EVENTS,
    supportedEvents: SUPPORTED_EVENTS,
    type: "pull_request",
  };
}
