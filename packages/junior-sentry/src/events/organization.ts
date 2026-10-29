import {
  eventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";

/** The identifier shape that `sentryOrganizationResource` builds. */
export const SENTRY_ORGANIZATION_IDENTIFIER = {
  format: "org",
  pattern: String.raw`^[^\s/:#]+$`,
};

/** Optional filters for organization-wide Sentry events. */
export const SENTRY_ORGANIZATION_MATCH_FIELDS = eventMatchFieldsSchema.parse({
  projects: {
    kind: "string",
    description:
      "Sentry project slugs of the event: the issue project, or each project on the metric alert rule",
    list: true,
  },
});

/** Build the stable Sentry organization identity used for org-wide events. */
export function sentryOrganizationResource(input: {
  org: string;
}): Pick<SubscribableResource, "identifier" | "label" | "namespace"> {
  return {
    identifier: input.org,
    label: `Sentry organization ${input.org}`,
    namespace: "sentry",
  };
}
