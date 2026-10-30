import {
  eventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { gitHubRepoMatchFields } from "./scope.js";

export const GITHUB_RELEASE_EVENTS = ["release.published"] as const;

/**
 * `tag` in event data, in the same form as in a release-source identifier:
 * URI-encoded, then lowercase, because the plugin lowercases identifiers.
 * Tags that differ only in case look the same. Tag names come from people,
 * and the encoding keeps their text out of trusted data. The raw tag is in
 * the untrusted text.
 */
export const gitHubReleaseTagDataSchema = z
  .string()
  .trim()
  .min(1)
  .transform((tag) => encodeURIComponent(tag).toLowerCase());

/** Exact values that every release event sets. */
export const GITHUB_RELEASE_MATCH_FIELDS = eventMatchFieldsSchema.parse({
  ...gitHubRepoMatchFields(GITHUB_RELEASE_EVENTS),
  tag: {
    kind: "string",
    description:
      "lowercase release tag, URI-encoded as in the identifier, such as v1.2.0",
    events: [...GITHUB_RELEASE_EVENTS],
  },
});

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
