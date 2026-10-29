import type { SubscribableResource } from "@sentry/junior-plugin-api";

export const GITHUB_RELEASE_EVENTS = ["release.published"] as const;

export const GITHUB_RELEASE_SUGGESTED_EVENTS = ["release.published"];

/** The identifier shape that `gitHubReleaseSourceResource` builds. */
export const GITHUB_RELEASE_SOURCE_IDENTIFIER = {
  format: "release-source:owner/repo[:tag]",
  pattern: String.raw`^release-source:[^\s/:#]+\/[^\s/:#]+(?::[^\s:]+)?$`,
};

/** Build the stable release-source identity shared by tools and webhooks. */
export function gitHubReleaseSourceResource(input: {
  repo: string;
  tag?: string;
}): Pick<SubscribableResource, "label" | "namespace" | "identifier"> {
  const repo = input.repo.toLowerCase();
  const tag = input.tag?.trim();
  return {
    label: `GitHub release for ${repo}`,
    namespace: "github",
    identifier: tag
      ? `release-source:${repo}:${encodeURIComponent(tag)}`
      : `release-source:${repo}`,
  };
}

/**
 * Describe a release source that a conversation can watch. Call
 * only when `ctx.events.canSubscribe` is true.
 */
export function gitHubReleaseSourceSubscribable(input: {
  repo: string;
  tag?: string;
}): SubscribableResource {
  return {
    ...gitHubReleaseSourceResource(input),
    suggestedEvents: GITHUB_RELEASE_SUGGESTED_EVENTS,
    supportedEvents: [...GITHUB_RELEASE_EVENTS],
    type: "release_source",
  };
}
