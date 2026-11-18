import {
  eventMatchFieldsSchema,
  type EventMatchFields,
} from "@sentry/junior-plugin-api";

/**
 * Filters on the GitHub user who sent the webhook: who wrote a comment or
 * review, or who made an issue update. Resource types that merge these maps
 * keep one description, so it names every case.
 */
export function gitHubSenderMatchFields(
  events: readonly string[],
): EventMatchFields {
  return eventMatchFieldsSchema.parse({
    senderId: {
      kind: "number",
      description:
        "immutable numeric GitHub user id of who wrote the comment or review, or made the update; prefer over logins",
      events,
    },
    senderLogin: {
      kind: "string",
      description:
        "GitHub login of who wrote the comment or review, or made the update; logins can be renamed",
      events,
    },
  });
}

/**
 * Filters on a GitHub comment or review: who wrote it and whether it mentions
 * the App. Issue comments, pull request comments, reviews, and inline review
 * comments set them, so the issue, pull request, and repository resource types
 * share one definition.
 */
export function gitHubCommentMatchFields(
  events: readonly string[],
): EventMatchFields {
  return eventMatchFieldsSchema.parse({
    mentionsBot: {
      kind: "boolean",
      description: "true when the comment or review mentions this GitHub App",
      events,
    },
    ...gitHubSenderMatchFields(events),
  });
}
