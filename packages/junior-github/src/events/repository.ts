import type { SubscribableResource } from "@sentry/junior-plugin-api";
import { GITHUB_DEPLOYMENT_EVENTS } from "./deployment.js";
import { GITHUB_ISSUE_EVENTS, GITHUB_ISSUE_SUGGESTED_EVENTS } from "./issue.js";
import {
  GITHUB_PULL_REQUEST_EVENTS,
  GITHUB_PULL_REQUEST_SUGGESTED_EVENTS,
} from "./pull-request.js";

/** The identifier shape that `gitHubRepositoryResource` builds. */
export const GITHUB_REPOSITORY_IDENTIFIER = {
  format: "owner/repo",
  pattern: String.raw`^[^\s/:#]+\/[^\s/:#]+$`,
};

/** Build the stable repository identity shared by tools and webhooks. */
export function gitHubRepositoryResource(input: {
  repo: string;
}): Pick<SubscribableResource, "label" | "namespace" | "identifier"> {
  return {
    label: `GitHub repository ${input.repo}`,
    namespace: "github",
    identifier: input.repo.toLowerCase(),
  };
}

/** Events that a repository Watch gets: deployments, issues, and pull requests. */
export const GITHUB_REPOSITORY_EVENTS = [
  ...GITHUB_DEPLOYMENT_EVENTS,
  ...GITHUB_ISSUE_EVENTS,
  ...GITHUB_PULL_REQUEST_EVENTS,
];

/** Repository events to suggest when a conversation starts a Watch. */
export const GITHUB_REPOSITORY_SUGGESTED_EVENTS = [
  "issue.opened",
  "pull_request.opened",
  ...GITHUB_ISSUE_SUGGESTED_EVENTS,
  ...GITHUB_PULL_REQUEST_SUGGESTED_EVENTS,
];

/**
 * Describe a repository as a resource that a conversation can watch. Call
 * only when `ctx.events.canSubscribe` is true.
 */
export function gitHubRepositorySubscribable(input: {
  repo: string;
}): SubscribableResource {
  return {
    ...gitHubRepositoryResource(input),
    suggestedEvents: [...GITHUB_REPOSITORY_SUGGESTED_EVENTS],
    supportedEvents: [...GITHUB_REPOSITORY_EVENTS],
    type: "repository",
  };
}
