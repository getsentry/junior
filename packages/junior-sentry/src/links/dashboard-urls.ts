/**
 * Sentry web URLs that name one dashboard, or one widget on it.
 *
 * Sentry shows a dashboard at `dashboard/<id>/` in both org URL forms, and
 * redirects `dashboards/<id>/` there. A widget opens at
 * `dashboard/<id>/widget/<index>/`, where the index counts the dashboard's
 * widgets in API order (`views/dashboards/detail.tsx` in getsentry/sentry).
 * The page filters in the URL replace the dashboard's saved ones.
 */
import type { ObjectLinkFilter } from "@sentry/junior-plugin-api";
import { timeRange, type TimeRange } from "./explore-urls.js";
import { sentryOrgPath } from "./urls.js";

// Short enough to stay exact as a number.
const DASHBOARD_ID_PATTERN = /^[1-9]\d{0,14}$/;
const WIDGET_INDEX_PATTERN = /^(0|[1-9]\d{0,3})$/;
// Sentry reads `-1` as all projects.
const PROJECT_PATTERN = /^(-1|[1-9]\d{0,18})$/;

/** Filters for dashboard pages. */
export const SENTRY_DASHBOARD_LINK_FILTERS: ObjectLinkFilter[] = [
  { host: "sentry.io", pathPattern: "/organizations/*/dashboard/*" },
  { host: "sentry.io", pathPattern: "/organizations/*/dashboards/*" },
  { host: "*.sentry.io", pathPattern: "/dashboard/*" },
  { host: "*.sentry.io", pathPattern: "/dashboards/*" },
];

/** Filters for the page of one dashboard widget. */
export const SENTRY_DASHBOARD_WIDGET_LINK_FILTERS: ObjectLinkFilter[] = [
  { host: "sentry.io", pathPattern: "/organizations/*/dashboard/*/widget/*" },
  { host: "*.sentry.io", pathPattern: "/dashboard/*/widget/*" },
];

/** The page filters that a dashboard URL sets. Unset ones stay saved. */
export interface DashboardPageFilters {
  project: string[];
  environment: string[];
  release: string[];
  range?: TimeRange;
}

/** A dashboard, or one widget on it, that a Sentry URL names. */
export interface SentryDashboardLink {
  org: string;
  dashboardId: number;
  widgetIndex?: number;
  filters: DashboardPageFilters;
}

function pageFilters(params: URLSearchParams): DashboardPageFilters {
  const hasRange =
    params.has("statsPeriod") || (params.has("start") && params.has("end"));
  const filters: DashboardPageFilters = {
    project: params.getAll("project").filter((id) => PROJECT_PATTERN.test(id)),
    environment: params.getAll("environment").filter(Boolean),
    release: params.getAll("release").filter(Boolean),
  };
  if (hasRange) filters.range = timeRange(params);
  return filters;
}

/**
 * Return the dashboard or widget that a Sentry URL names, or nothing for
 * another page, such as `dashboards/new/`. Run it after a filter matched.
 */
export function parseSentryDashboardLink(
  url: URL,
): SentryDashboardLink | undefined {
  const orgPath = sentryOrgPath(url);
  if (!orgPath) return undefined;
  const [page, id = "", widget, index = "", ...extra] = orgPath.segments;
  if (page !== "dashboard" && page !== "dashboards") return undefined;
  if (!DASHBOARD_ID_PATTERN.test(id) || extra.length > 0) return undefined;
  const link: SentryDashboardLink = {
    org: orgPath.org,
    dashboardId: Number(id),
    filters: pageFilters(url.searchParams),
  };
  if (widget === undefined) return link;
  if (
    page !== "dashboard" ||
    widget !== "widget" ||
    !WIDGET_INDEX_PATTERN.test(index)
  ) {
    return undefined;
  }
  link.widgetIndex = Number(index);
  return link;
}
