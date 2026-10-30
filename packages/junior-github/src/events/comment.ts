import {
  eventMatchFieldsSchema,
  type EventMatchFields,
} from "@sentry/junior-plugin-api";

/**
 * Filters on who wrote a GitHub comment or review. Issue comments, pull
 * request comments, reviews, and inline review comments set them, so the
 * issue, pull request, and repository resource types share one definition.
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
    senderId: {
      kind: "number",
      description:
        "immutable numeric GitHub user id of who wrote the comment or review; prefer over logins",
      events,
    },
    senderLogin: {
      kind: "string",
      description:
        "GitHub login of who wrote the comment or review; logins can be renamed",
      events,
    },
  });
}
