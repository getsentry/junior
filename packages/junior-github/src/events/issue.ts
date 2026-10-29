import type { SubscribableResource } from "@sentry/junior-plugin-api";
import { gitHubCommentMatchFields } from "./comment.js";

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

/**
 * Exact values GitHub sets on issue comment event data. Only
 * `issue.comment.created` sets them, so a trigger with these filters cannot
 * select other events.
 */
export const GITHUB_ISSUE_COMMENT_MATCH_FIELDS = gitHubCommentMatchFields([
  "issue.comment.created",
]);

/** The identifier shape that `gitHubIssueResource` builds. */
export const GITHUB_ISSUE_IDENTIFIER = {
  format: "owner/repo#number",
  pattern: String.raw`^[^\s/:#]+\/[^\s/:#]+#\d+$`,
};

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

/**
 * Describe an issue as a resource that a conversation can watch.
 * Return undefined when the host cannot create Watches.
 */
export function gitHubIssueSubscribable(input: {
  /** `ctx.events.canSubscribe` from the tool context. */
  canSubscribe: boolean;
  number: number;
  repo: string;
}): SubscribableResource | undefined {
  if (!input.canSubscribe) return undefined;
  return {
    ...gitHubIssueResource(input),
    suggestedEvents: GITHUB_ISSUE_SUGGESTED_EVENTS,
    supportedEvents: GITHUB_ISSUE_EVENTS,
    type: "issue",
  };
}
