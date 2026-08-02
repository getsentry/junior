import type { SubscribableResource } from "@sentry/junior-plugin-api";

export const GITHUB_ISSUE_EVENTS = [
  "issue.comment.created",
  "issue.opened",
  "issue.closed",
  "issue.reopened",
];
export const GITHUB_ISSUE_SUGGESTED_EVENTS = [
  "issue.comment.created",
  "issue.closed",
  "issue.reopened",
];

/** Build the stable issue identity shared by tools and webhooks. */
export function gitHubIssueResource(input: {
  number: number;
  repo: string;
}): Pick<SubscribableResource, "label" | "namespace" | "identifier"> {
  return {
    label: `GitHub issue ${input.repo}#${input.number}`,
    namespace: "github",
    identifier: `${input.repo.toLowerCase()}#${input.number}`,
  };
}

/** Describe an issue as a resource when webhook subscriptions are enabled. */
export function gitHubIssueSubscribable(input: {
  number: number;
  repo: string;
}): SubscribableResource | undefined {
  if (!process.env.GITHUB_WEBHOOK_SECRET?.trim()) return undefined;
  return {
    ...gitHubIssueResource(input),
    suggestedEvents: GITHUB_ISSUE_SUGGESTED_EVENTS,
    supportedEvents: GITHUB_ISSUE_EVENTS,
    type: "issue",
  };
}
