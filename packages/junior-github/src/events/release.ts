import {
  eventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { gitHubRepoMatchFields } from "./scope.js";

export const GITHUB_RELEASE_EVENTS = ["release.published"] as const;

/**
 * `tag` in event data: the trimmed tag with ASCII letters in lowercase. The
 * release-source identifier has the URI-encoded tag, and the plugin
 * lowercases identifiers. Encoding turns other characters into `%XX`
 * escapes, so only ASCII letters change case there. This form is the same
 * text, so `release/1.0` is not `release%2f1.0`, and `Ü` stays `Ü`. To turn
 * an identifier into a `tag` filter, decode its tag part.
 */
export const gitHubReleaseTagDataSchema = z
  .string()
  .trim()
  .min(1)
  .transform((tag) =>
    tag.replace(/[A-Z]+/g, (letters) => letters.toLowerCase()),
  );

/** Exact values that every release event sets. */
export const GITHUB_RELEASE_MATCH_FIELDS = eventMatchFieldsSchema.parse({
  ...gitHubRepoMatchFields(GITHUB_RELEASE_EVENTS),
  tag: {
    kind: "string",
    description:
      "release tag with ASCII letters in lowercase, such as v1.2.0 or release/1.0",
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
