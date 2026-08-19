import type { SubscribableResource } from "@sentry/junior-plugin-api";

export const GITHUB_PULL_REQUEST_EVENTS = [
  "pull_request.checks.failed",
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
] as const;
export type GitHubPullRequestEvent =
  (typeof GITHUB_PULL_REQUEST_EVENTS)[number];

/** Install-local pull request resource event behavior. */
export interface GitHubPullRequestEventOptions {
  /** Guidance added when one pull request event reaches the agent. */
  guidance?: Partial<Record<GitHubPullRequestEvent, string>>;
  /** Temporary subscription created after Junior creates a pull request. */
  subscribeAfterCreate?: GitHubPullRequestSubscriptionConfig;
}

/** Temporary subscription created after Junior creates a pull request. */
export interface GitHubPullRequestSubscriptionConfig {
  events: GitHubPullRequestEvent[];
  intent: string;
  ttlMs?: number;
}

export const GITHUB_PULL_REQUEST_SUGGESTED_EVENTS = [
  "pull_request.checks.failed",
  "pull_request.comment.created",
  "pull_request.ready_for_review",
  "pull_request.review.changes_requested",
  "pull_request.review.commented",
  "pull_request.review_comment.created",
  "pull_request.merged",
  "pull_request.closed_unmerged",
] as const;

/** Build the stable pull request identity shared by tools and webhooks. */
export function gitHubPullRequestResource(input: {
  number: number;
  repo: string;
}): Pick<SubscribableResource, "label" | "namespace" | "identifier"> {
  return {
    label: `GitHub PR ${input.repo}#${input.number}`,
    namespace: "github",
    identifier: `${input.repo.toLowerCase()}#${input.number}`,
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
    suggestedEvents: [...GITHUB_PULL_REQUEST_SUGGESTED_EVENTS],
    supportedEvents: [...GITHUB_PULL_REQUEST_EVENTS],
    type: "pull_request",
  };
}
