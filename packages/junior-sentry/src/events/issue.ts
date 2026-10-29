import {
  eventIdentifierSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";

export const SENTRY_ISSUE_EVENTS = ["issue.created"] as const;

const ORG_AND_PROJECT = {
  org: { kind: "string", description: "Sentry organization slug" },
  project: { kind: "string", description: "Sentry project slug" },
} as const;

/** The identifier format that `sentryIssueResource` builds. */
export const SENTRY_ISSUE_IDENTIFIER = eventIdentifierSchema.parse({
  template: "{org}/{project}#{issueId}",
  parts: {
    ...ORG_AND_PROJECT,
    issueId: { kind: "number", description: "numeric Sentry issue ID" },
  },
});

/** The identifier format that `sentryProjectResource` builds. */
export const SENTRY_PROJECT_IDENTIFIER = eventIdentifierSchema.parse({
  template: "{org}/{project}",
  parts: ORG_AND_PROJECT,
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
