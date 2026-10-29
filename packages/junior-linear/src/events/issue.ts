import {
  eventIdentifierSchema,
  eventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";

export const LINEAR_ISSUE_EVENTS = ["issue.created"] as const;

/** Exact values Linear may set on issue event data. Missing keys do not match. */
export const LINEAR_ISSUE_MATCH_FIELDS = eventMatchFieldsSchema.parse({
  teamKey: {
    kind: "string",
    description: "Linear team key for the issue, such as SRE",
  },
});

const TEAM_KEY = {
  kind: "string",
  description: "uppercase Linear team key, such as SRE",
} as const;

/** The identifier format that `linearIssueResource` builds. */
export const LINEAR_ISSUE_IDENTIFIER = eventIdentifierSchema.parse({
  template: "{teamKey}-{number}",
  parts: {
    teamKey: TEAM_KEY,
    number: { kind: "number", description: "Linear issue number in the team" },
  },
});

/** The identifier format that `linearTeamResource` builds. */
export const LINEAR_TEAM_IDENTIFIER = eventIdentifierSchema.parse({
  template: "{teamKey}",
  parts: { teamKey: TEAM_KEY },
});

/** Build the stable Linear issue identity shared by tools and webhooks. */
export function linearIssueResource(input: {
  identifier: string;
}): Pick<SubscribableResource, "identifier" | "label" | "namespace"> {
  const identifier = input.identifier.toUpperCase();
  return {
    identifier,
    label: `Linear issue ${identifier}`,
    namespace: "linear",
  };
}

/** Build the stable Linear team identity used for team-scoped events. */
export function linearTeamResource(input: {
  teamKey: string;
}): Pick<SubscribableResource, "identifier" | "label" | "namespace"> {
  const teamKey = input.teamKey.toUpperCase();
  return {
    identifier: teamKey,
    label: `Linear team ${teamKey}`,
    namespace: "linear",
  };
}
