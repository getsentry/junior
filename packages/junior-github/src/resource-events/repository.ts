import type { SubscribableResource } from "@sentry/junior-plugin-api";
import { GITHUB_ISSUE_EVENTS, GITHUB_ISSUE_SUGGESTED_EVENTS } from "./issue.js";

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

/** Describe a repository as a resource when webhook subscriptions are enabled. */
export function gitHubRepositorySubscribable(input: {
  repo: string;
}): SubscribableResource | undefined {
  if (!process.env.GITHUB_WEBHOOK_SECRET?.trim()) return undefined;
  return {
    ...gitHubRepositoryResource(input),
    suggestedEvents: ["issue.opened", ...GITHUB_ISSUE_SUGGESTED_EVENTS],
    supportedEvents: GITHUB_ISSUE_EVENTS,
    type: "repository",
  };
}
