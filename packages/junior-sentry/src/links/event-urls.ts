/**
 * Sentry web URLs that name one event by project and event id.
 *
 * Sentry serves `projects/<project>/events/<id>/` in both org URL forms,
 * and the legacy `sentry.io/<org>/<project>/events/<id>/`. Each redirects
 * to the event's issue page, or to its trace when it has no issue
 * (`ProjectEventRedirect` in getsentry/sentry). Discover event pages are
 * left out.
 */
import type { ObjectLinkFilter } from "@sentry/junior-plugin-api";
import { ORG_SLUG_PATTERN, sentryOrgPath } from "./urls.js";

const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,99}$/;
// Clients send the id as 32 hex digits or as a UUID with dashes.
const EVENT_ID_PATTERN =
  /^[0-9a-f]{32}$|^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Filters for the project event pages. */
export const SENTRY_EVENT_LINK_FILTERS: ObjectLinkFilter[] = [
  { host: "sentry.io", pathPattern: "/organizations/*/projects/*/events/*" },
  { host: "*.sentry.io", pathPattern: "/projects/*/events/*" },
  { host: "sentry.io", pathPattern: "/*/*/events/*" },
];

/** An event that a Sentry URL names. */
export interface SentryEventLink {
  org: string;
  project: string;
  eventId: string;
}

// The org and the path after it, including the legacy form, which has no
// `organizations/` and no customer domain.
function orgPath(url: URL): { org: string; segments: string[] } | undefined {
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.host.toLowerCase() === "sentry.io" && segments[2] === "events") {
    const [org, ...rest] = segments;
    if (!org || org === "organizations" || !ORG_SLUG_PATTERN.test(org)) {
      return undefined;
    }
    return { org, segments: ["projects", ...rest] };
  }
  return sentryOrgPath(url);
}

/**
 * Return the event that a Sentry URL names, or nothing for another page.
 * Run it after a filter matched.
 */
export function parseSentryEventLink(url: URL): SentryEventLink | undefined {
  const path = orgPath(url);
  if (!path) return undefined;
  const [projects, project, events, eventId, ...extra] = path.segments;
  if (projects !== "projects" || events !== "events" || extra.length > 0) {
    return undefined;
  }
  if (!project || !PROJECT_SLUG_PATTERN.test(project)) return undefined;
  if (!eventId || !EVENT_ID_PATTERN.test(eventId)) return undefined;
  return {
    org: path.org,
    project,
    eventId: eventId.replaceAll("-", "").toLowerCase(),
  };
}
