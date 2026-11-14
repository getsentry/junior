/**
 * Sentry web URLs that name a trace.
 *
 * Sentry shows a trace at `explore/traces/trace/<id>/`, and older links use
 * `performance/trace/<id>/`. Both work in both org URL forms.
 */
import type { ObjectLinkFilter } from "@sentry/junior-plugin-api";
import { sentryOrgPath } from "./urls.js";

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const TRACE_PAGES = ["explore/traces/trace", "performance/trace"];
// The trace view puts the time of a trace event in `timestamp`, in Unix
// seconds, so Sentry can find the trace without a scan.
const TIMESTAMP_PATTERN = /^\d{9,11}(\.\d+)?$/;

/** Filters for the trace view pages. */
export const SENTRY_TRACE_LINK_FILTERS: ObjectLinkFilter[] =
  TRACE_PAGES.flatMap((page) => [
    { host: "sentry.io", pathPattern: `/organizations/*/${page}/*` },
    { host: "*.sentry.io", pathPattern: `/${page}/*` },
  ]);

/** A trace that a Sentry URL names. */
export interface SentryTraceLink {
  org: string;
  traceId: string;
  timestamp?: string;
}

/**
 * Return the trace that a Sentry URL names, or nothing for another page.
 * Run it after a filter matched.
 */
export function parseSentryTraceLink(url: URL): SentryTraceLink | undefined {
  const orgPath = sentryOrgPath(url);
  if (!orgPath) return undefined;
  const traceId = orgPath.segments.at(-1) ?? "";
  const page = orgPath.segments.slice(0, -1).join("/");
  if (!TRACE_PAGES.includes(page) || !TRACE_ID_PATTERN.test(traceId)) {
    return undefined;
  }
  const timestamp = url.searchParams.get("timestamp") ?? "";
  return {
    org: orgPath.org,
    traceId: traceId.toLowerCase(),
    ...(TIMESTAMP_PATTERN.test(timestamp) && { timestamp }),
  };
}
