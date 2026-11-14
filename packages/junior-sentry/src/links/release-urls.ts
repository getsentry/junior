/**
 * Sentry web URLs that name one release.
 *
 * Sentry shows a release at `releases/<version>/` and at
 * `explore/releases/<version>/`, in both org URL forms, with the tabs
 * `commits/`, `files-changed/`, and `builds/` under it. The version is one
 * URL-encoded path segment.
 */
import type { ObjectLinkFilter } from "@sentry/junior-plugin-api";
import { sentryOrgPath } from "./urls.js";

const RELEASE_PAGES = ["releases", "explore/releases"];
const RELEASE_TABS = ["commits", "files-changed", "builds"];
// Sentry's list pages and redirects that sit where a version would.
const NOT_VERSIONS = ["new-events", "all-events"];
const PROJECT_ID_PATTERN = /^[1-9]\d{0,18}$/;

/** Filters for the release pages and their tabs. */
export const SENTRY_RELEASE_LINK_FILTERS: ObjectLinkFilter[] =
  RELEASE_PAGES.flatMap((page) =>
    ["*", "*/*"].flatMap((rest) => [
      { host: "sentry.io", pathPattern: `/organizations/*/${page}/${rest}` },
      { host: "*.sentry.io", pathPattern: `/${page}/${rest}` },
    ]),
  );

/** A release that a Sentry URL names. */
export interface SentryReleaseLink {
  org: string;
  version: string;
  /** The project id that the page is filtered to, when it names one. */
  project?: string;
}

function decodeVersion(segment: string): string | undefined {
  try {
    const version = decodeURIComponent(segment);
    return version.trim() && version.length <= 250 ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return the release that a Sentry URL names, or nothing for another page.
 * Run it after a filter matched.
 */
export function parseSentryReleaseLink(
  url: URL,
): SentryReleaseLink | undefined {
  const orgPath = sentryOrgPath(url);
  if (!orgPath) return undefined;
  const { segments } = orgPath;
  const page = RELEASE_PAGES.map((prefix) => prefix.split("/")).find((prefix) =>
    prefix.every((segment, index) => segments[index] === segment),
  );
  if (!page) return undefined;
  const [encoded = "", tab, ...extra] = segments.slice(page.length);
  if (extra.length > 0 || (tab !== undefined && !RELEASE_TABS.includes(tab))) {
    return undefined;
  }
  if (NOT_VERSIONS.includes(encoded)) return undefined;
  const version = decodeVersion(encoded);
  if (!version) return undefined;
  // A page filtered to one project shows that project's numbers.
  const projects = url.searchParams.getAll("project");
  const project =
    projects.length === 1 && PROJECT_ID_PATTERN.test(projects[0]!)
      ? projects[0]
      : undefined;
  const link: SentryReleaseLink = { org: orgPath.org, version };
  if (project) link.project = project;
  return link;
}
