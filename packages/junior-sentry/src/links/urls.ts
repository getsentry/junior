/**
 * Sentry web URLs that name an issue.
 *
 * Sentry serves each org at `sentry.io/organizations/<org>/` and at its
 * customer domain `<org>.sentry.io`. These are the forms that Sentry's own
 * Slack unfurl matches (`integrations/slack/unfurl/issues.py`).
 *
 * A user feedback is an issue too. Its page is `feedback/` or
 * `issues/feedback/`, and `?feedbackSlug=<project>:<issue id>` names it.
 */
import type { ObjectLinkFilter } from "@sentry/junior-plugin-api";

/** A Sentry org slug. */
export const ORG_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,49}$/;
const NUMERIC_ISSUE_ID_PATTERN = /^[1-9]\d{0,18}$/;
// `<PROJECT>-<suffix>`. The suffix is Crockford base32, and Sentry reads
// I, L, and O as 1, 1, and 0 (`base32_decode`).
const SHORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}-[0-9A-Za-z]{1,13}$/;
const SHORT_ID_SUFFIX_PATTERN = /^[0-9A-HJ-NP-TV-Z]+$/i;
const EVENT_ID_PATTERN = /^([0-9a-f]{32}|latest|recommended|oldest)$/i;
const FEEDBACK_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,99}:([1-9]\d{0,18})$/;

/** Filters for issue pages, the event pages of an issue, and feedback pages. */
export const SENTRY_ISSUE_LINK_FILTERS: ObjectLinkFilter[] = [
  { host: "sentry.io", pathPattern: "/organizations/*/issues/*" },
  { host: "sentry.io", pathPattern: "/organizations/*/issues/*/events/*" },
  { host: "*.sentry.io", pathPattern: "/issues/*" },
  { host: "*.sentry.io", pathPattern: "/issues/*/events/*" },
  // `issues/feedback/` matches the `issues/*` filters.
  { host: "sentry.io", pathPattern: "/organizations/*/feedback" },
  { host: "*.sentry.io", path: "/feedback" },
];

/** An issue that a Sentry URL names. `issueId` is numeric or a short id. */
export interface SentryIssueLink {
  issueId: string;
  org: string;
}

function isIssueId(value: string): boolean {
  if (NUMERIC_ISSUE_ID_PATTERN.test(value)) return true;
  if (!SHORT_ID_PATTERN.test(value)) return false;
  return SHORT_ID_SUFFIX_PATTERN.test(value.slice(value.lastIndexOf("-") + 1));
}

/** Return the org of a customer domain, such as `acme` for `acme.sentry.io`. */
function customerDomainOrg(host: string): string | undefined {
  const labels = host.toLowerCase().split(".");
  return labels.length === 3 && labels[1] === "sentry" && labels[2] === "io"
    ? labels[0]
    : undefined;
}

/**
 * Split a Sentry web URL into its org and the path segments after the org,
 * for both URL forms. Nothing when the URL names no valid org.
 */
export function sentryOrgPath(
  url: URL,
): { org: string; segments: string[] } | undefined {
  const segments = url.pathname.split("/").filter(Boolean);
  const host = url.host.toLowerCase();
  const [org, rest] =
    host === "sentry.io" && segments[0] === "organizations"
      ? [segments[1], segments.slice(2)]
      : [customerDomainOrg(host), segments];
  if (!org || !ORG_SLUG_PATTERN.test(org)) return undefined;
  return { org, segments: rest };
}

// The issue id of the feedback that `feedbackSlug` names.
function feedbackIssueId(url: URL): string | undefined {
  const slug = url.searchParams.get("feedbackSlug")?.toLowerCase();
  return slug?.match(FEEDBACK_SLUG_PATTERN)?.[1];
}

/**
 * Return the issue that a Sentry URL names, or nothing for another page.
 * Run it after a filter matched, so the path has the filter's shape.
 */
export function parseSentryIssueLink(url: URL): SentryIssueLink | undefined {
  const orgPath = sentryOrgPath(url);
  if (!orgPath) return undefined;
  const { org, segments } = orgPath;
  const path = segments.join("/");
  if (path === "feedback" || path === "issues/feedback") {
    const issueId = feedbackIssueId(url);
    return issueId ? { issueId, org } : undefined;
  }
  const [issues, issueId, events, eventId, ...extra] = segments;
  if (issues !== "issues" || !issueId || !isIssueId(issueId)) return undefined;
  if (extra.length > 0) return undefined;
  if (events !== undefined) {
    if (events !== "events" || !eventId || !EVENT_ID_PATTERN.test(eventId)) {
      return undefined;
    }
  }
  return { issueId, org };
}
