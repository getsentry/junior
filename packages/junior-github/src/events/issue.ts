import {
  eventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";
import { gitHubCommentMatchFields } from "./comment.js";
import { gitHubRepoDataSchema, gitHubRepoMatchFields } from "./scope.js";

export const GITHUB_ISSUE_EVENTS = [
  "issue.comment.created",
  "issue.opened",
  "issue.closed",
  "issue.reopened",
  "issue.updated",
];
export const GITHUB_ISSUE_SUGGESTED_EVENTS = [
  "issue.comment.created",
  "issue.closed",
  "issue.reopened",
  "issue.updated",
];

// The `issues` webhook actions that `issue.updated` publishes.
const ISSUE_UPDATE_CHANGES = [
  "edited",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "milestoned",
  "demilestoned",
];

const SENDER_EVENTS = ["issue.comment.created", "issue.updated"];

/**
 * Exact values GitHub sets on issue event data. Every issue event sets the
 * repository and issue number. Comments and updates set who acted. Only
 * updates set `change` and `label`, so an automation can run on one label
 * that one person adds without the model reading label text.
 */
export const GITHUB_ISSUE_MATCH_FIELDS = eventMatchFieldsSchema.parse({
  ...gitHubCommentMatchFields(["issue.comment.created"]),
  ...gitHubRepoMatchFields(GITHUB_ISSUE_EVENTS),
  issue: {
    kind: "number",
    description: "issue number, such as 12",
    events: GITHUB_ISSUE_EVENTS,
  },
  senderId: {
    kind: "number",
    description:
      "immutable numeric GitHub user id of who wrote the comment or made the update; prefer over logins",
    events: SENDER_EVENTS,
  },
  senderLogin: {
    kind: "string",
    description:
      "GitHub login of who wrote the comment or made the update; logins can be renamed",
    events: SENDER_EVENTS,
  },
  change: {
    kind: "string",
    enum: ISSUE_UPDATE_CHANGES,
    description: "what the issue update changed, such as labeled",
    events: ["issue.updated"],
  },
  label: {
    kind: "string",
    case: "lower",
    description:
      "lowercase name of the label that was added or removed, set only when change is labeled or unlabeled",
    events: ["issue.updated"],
  },
});

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
    match: {
      repo: gitHubRepoDataSchema.parse(input.repo),
      issue: input.number,
    },
    suggested_events: GITHUB_ISSUE_SUGGESTED_EVENTS,
    supported_events: GITHUB_ISSUE_EVENTS,
    type: "issue",
  };
}
