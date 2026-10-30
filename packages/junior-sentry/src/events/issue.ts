import {
  eventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";

export const SENTRY_ISSUE_EVENTS = ["issue.created"] as const;

/** Issue levels that Sentry sets, from most to least severe. */
export const SENTRY_ISSUE_LEVELS = [
  "fatal",
  "error",
  "warning",
  "info",
  "debug",
] as const;

/** Issue priorities that Sentry sets. */
export const SENTRY_ISSUE_PRIORITIES = ["high", "medium", "low"] as const;

/** Trusted values that Sentry issue events set, when the webhook has them. */
export const SENTRY_ISSUE_MATCH_FIELDS = eventMatchFieldsSchema.parse({
  level: {
    kind: "string",
    description: "issue level: fatal, error, warning, info, or debug",
    enum: [...SENTRY_ISSUE_LEVELS],
    events: [...SENTRY_ISSUE_EVENTS],
  },
  priority: {
    kind: "string",
    description: "issue priority: high, medium, or low",
    enum: [...SENTRY_ISSUE_PRIORITIES],
    events: [...SENTRY_ISSUE_EVENTS],
  },
  issueCategory: {
    kind: "string",
    description:
      "kind of problem, such as error, performance, cron, or feedback",
    events: [...SENTRY_ISSUE_EVENTS],
  },
});

/** Build the stable Sentry issue identity shared by tools and webhooks. */
export function sentryIssueResource(input: {
  issueId: string;
  org: string;
  project: string;
}): Pick<SubscribableResource, "identifier" | "label" | "namespace"> {
  return {
    identifier: `${input.org}/${input.project}#${input.issueId}`,
    label: `Sentry issue ${input.org}/${input.project}#${input.issueId}`,
    namespace: "sentry",
  };
}

/** Build the stable Sentry project identity used for project-scoped events. */
export function sentryProjectResource(input: {
  org: string;
  project: string;
}): Pick<SubscribableResource, "identifier" | "label" | "namespace"> {
  return {
    identifier: `${input.org}/${input.project}`,
    label: `Sentry project ${input.org}/${input.project}`,
    namespace: "sentry",
  };
}
