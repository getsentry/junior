import type { SubscribableResource } from "@sentry/junior-plugin-api";

export const SENTRY_ISSUE_EVENTS = ["issue.created"] as const;

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
