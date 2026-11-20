/**
 * Sentry web URLs that name one monitor: a metric alert, a cron job, or an
 * uptime check.
 *
 * Sentry shows each one at `monitors/<detectorId>/`, in both org URL
 * forms. The older alert pages still serve an uptime check at
 * `alerts/rules/uptime/<project>/<detectorId>/details/` and a cron job at
 * `alerts/rules/crons/<project>/<slug>/details/` (`routes.tsx` in
 * getsentry/sentry). The older metric alert page names a rule id, which
 * the public API cannot map to its monitor, so it is left out.
 */
import type { ObjectLinkFilter } from "@sentry/junior-plugin-api";
import { sentryOrgPath } from "./urls.js";

// Ids stay within the integers that a number holds exactly.
const DETECTOR_ID_PATTERN = /^[1-9]\d{0,14}$/;
const MONITOR_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,99}$/i;

const MONITOR_PAGES = [
  "monitors/*",
  "alerts/rules/uptime/*/*/details",
  "alerts/rules/crons/*/*/details",
];

/** Filters for the monitor pages. */
export const SENTRY_MONITOR_LINK_FILTERS: ObjectLinkFilter[] =
  MONITOR_PAGES.flatMap((page) => [
    { host: "sentry.io", pathPattern: `/organizations/*/${page}` },
    { host: "*.sentry.io", pathPattern: `/${page}` },
  ]);

/**
 * A monitor that a Sentry URL names: by detector id, or a cron job by its
 * slug on the older cron page.
 */
export type SentryMonitorLink =
  | { org: string; detectorId: number }
  | { org: string; cronSlug: string };

/**
 * Return the monitor that a Sentry URL names, or nothing for another page.
 * Run it after a filter matched.
 */
export function parseSentryMonitorLink(
  url: URL,
): SentryMonitorLink | undefined {
  const path = sentryOrgPath(url);
  if (!path) return undefined;
  const { org, segments } = path;
  if (segments[0] === "monitors" && segments.length === 2) {
    const id = segments[1] ?? "";
    return DETECTOR_ID_PATTERN.test(id)
      ? { org, detectorId: Number(id) }
      : undefined;
  }
  const [alerts, rules, kind, , id, details, ...extra] = segments;
  if (alerts !== "alerts" || rules !== "rules" || details !== "details") {
    return undefined;
  }
  if (extra.length > 0 || !id) return undefined;
  if (kind === "uptime" && DETECTOR_ID_PATTERN.test(id)) {
    return { org, detectorId: Number(id) };
  }
  if (kind === "crons" && MONITOR_SLUG_PATTERN.test(id)) {
    return { org, cronSlug: id };
  }
  return undefined;
}
