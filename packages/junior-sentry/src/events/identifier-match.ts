import type { EventMatch } from "@sentry/junior-plugin-api";
import { sentryIssueResource, sentryProjectResource } from "./issue.js";
import { sentryMetricAlertResource } from "./metric-alert.js";

const SLUG = String.raw`[^\s/:#]+`;
const METRIC_ALERT = new RegExp(String.raw`^metric-alert:(${SLUG})\/(\d+)$`);
const PROJECT = new RegExp(String.raw`^(${SLUG})\/(${SLUG})(?:#(\d+))?$`);

/** Filters for one identifier, with the identifier that the plugin builds from them. */
function identifierFilters(
  identifier: string,
  eventType: string,
): { match: EventMatch; built: string } | undefined {
  const alert = METRIC_ALERT.exec(identifier);
  if (alert) {
    if (!eventType.startsWith("metric_alert.")) return undefined;
    const [, org, alertRuleId] = alert;
    return {
      match: { alertRuleId: alertRuleId! },
      built: sentryMetricAlertResource({ org: org!, alertRuleId: alertRuleId! })
        .identifier,
    };
  }
  const scope = PROJECT.exec(identifier);
  // Metric alert events leave out `projects` when the rule has too many
  // projects to fit in event data. A project identifier still gets those
  // events, so a `projects` filter would miss them.
  if (!scope || eventType !== "issue.created") return undefined;
  const [, org, project, issueId] = scope;
  return issueId === undefined
    ? {
        match: { projects: project! },
        built: sentryProjectResource({ org: org!, project: project! })
          .identifier,
      }
    : {
        match: { projects: project!, issueId },
        built: sentryIssueResource({
          org: org!,
          project: project!,
          issueId,
        }).identifier,
      };
}

/**
 * Turn a saved Sentry identifier into the filters that select the same
 * events of one type. One install is one Sentry org, so the org part of an
 * identifier needs no filter. A project identifier converts only for issue
 * events, because metric alert events can leave out `projects`.
 *
 * The filters must rebuild the same identifier with the builder that the
 * webhooks use, so a malformed identifier keeps its identifier.
 */
export function sentryIdentifierMatch(input: {
  identifier: string;
  eventType: string;
}): EventMatch | undefined {
  const filters = identifierFilters(input.identifier, input.eventType);
  // Saved identifiers went through the plugin's `normalizeIdentifier`.
  if (!filters || filters.built.toLowerCase() !== input.identifier) {
    return undefined;
  }
  return filters.match;
}
