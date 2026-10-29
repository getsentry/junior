import {
  eventIdentifierSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";
import { GITHUB_REPOSITORY_PARTS } from "./identifier-parts.js";

export const GITHUB_RELEASE_EVENTS = ["release.published"] as const;

export const GITHUB_RELEASE_SUGGESTED_EVENTS = ["release.published"];

/** The identifier format that `gitHubReleaseSourceResource` builds. */
export const GITHUB_RELEASE_SOURCE_IDENTIFIER = eventIdentifierSchema.parse({
  template: "release-source:{owner}/{repo}[:{tag}]",
  parts: {
    ...GITHUB_REPOSITORY_PARTS,
    tag: {
      kind: "string",
      description:
        "optional lowercase release tag, percent-encoded, such as v1.2.0. Leave it out to match every release.",
    },
  },
});

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
 * Describe a release source that a conversation can watch.
 * Return undefined when the host cannot create Watches.
 */
export function gitHubReleaseSourceSubscribable(input: {
  /** `ctx.events.canSubscribe` from the tool context. */
  canSubscribe: boolean;
  repo: string;
  tag?: string;
}): SubscribableResource | undefined {
  if (!input.canSubscribe) return undefined;
  return {
    ...gitHubReleaseSourceResource(input),
    suggestedEvents: GITHUB_RELEASE_SUGGESTED_EVENTS,
    supportedEvents: [...GITHUB_RELEASE_EVENTS],
    type: "release_source",
  };
}
