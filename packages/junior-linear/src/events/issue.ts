import {
  eventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";

export const LINEAR_ISSUE_EVENTS = ["issue.created"] as const;

/**
 * Exact values that every Linear issue event sets. `issueIdentifier` and
 * `teamKey` are uppercase, the same form as identifiers.
 */
export const LINEAR_ISSUE_MATCH_FIELDS = eventMatchFieldsSchema.parse({
  issueIdentifier: {
    kind: "string",
    case: "upper",
    description: "uppercase Linear issue identifier, such as SRE-123",
    events: [...LINEAR_ISSUE_EVENTS],
  },
  teamKey: {
    kind: "string",
    case: "upper",
    description: "uppercase Linear team key for the issue, such as SRE",
    events: [...LINEAR_ISSUE_EVENTS],
  },
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
