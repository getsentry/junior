/**
 * Sentry web URLs that name one alert: a workflow that notifies people when
 * its monitors open or change an issue.
 *
 * Sentry shows each one at `monitors/alerts/<workflowId>/`, in both org URL
 * forms. The older issue alert page `alerts/rules/<project>/<ruleId>/details/`
 * names a rule id. Only the experimental `alert-rule-workflow` endpoint maps
 * a rule to its workflow, not the public API, so that page is left out.
 */
import type { ObjectLinkFilter } from "@sentry/junior-plugin-api";
import { sentryOrgPath } from "./urls.js";

// Ids stay within the integers that a number holds exactly.
const WORKFLOW_ID_PATTERN = /^[1-9]\d{0,14}$/;

/** Filters for the alert pages. */
export const SENTRY_ALERT_LINK_FILTERS: ObjectLinkFilter[] = [
  { host: "sentry.io", pathPattern: "/organizations/*/monitors/alerts/*" },
  { host: "*.sentry.io", pathPattern: "/monitors/alerts/*" },
];

/** An alert that a Sentry URL names, by its workflow id. */
export interface SentryAlertLink {
  org: string;
  workflowId: number;
}

/**
 * Return the alert that a Sentry URL names, or nothing for another page.
 * Run it after a filter matched.
 */
export function parseSentryAlertLink(url: URL): SentryAlertLink | undefined {
  const path = sentryOrgPath(url);
  if (!path) return undefined;
  const [monitors, alerts, id, ...extra] = path.segments;
  if (monitors !== "monitors" || alerts !== "alerts" || extra.length > 0) {
    return undefined;
  }
  return id && WORKFLOW_ID_PATTERN.test(id)
    ? { org: path.org, workflowId: Number(id) }
    : undefined;
}
