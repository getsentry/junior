import {
  browserTracingIntegration,
  init,
  type BrowserOptions,
} from "@sentry/browser";
import type { BrowserSentryConfig } from "@sentry/junior/instrumentation";

declare global {
  interface Window {
    __JUNIOR_DASHBOARD_SENTRY__?: Omit<
      BrowserSentryConfig,
      "baggage" | "sentryTrace"
    >;
  }
}

type StreamedSpanJSON = Parameters<
  NonNullable<BrowserOptions["beforeSendSpan"]>
>[0];

const QUERY_ATTRIBUTE_KEYS = [
  "http.fragment",
  "http.query",
  "url.fragment",
  "url.query",
];
// Element selectors in interaction and web vital attributes include these
// attribute values, such as a conversation title in an `aria-label`. The SDK
// does not escape quotes in values, so a value can contain `"]` and fake
// selector parts. Cutting from the first marker to the last `"]` removes every
// value, at the cost of the selector parts between them.
const ELEMENT_ATTRIBUTE_START = /\[(?:aria-label|type|name|title|alt)="/;

function scrubSelector(value: string): string {
  const start = value.search(ELEMENT_ATTRIBUTE_START);
  if (start === -1) return value;
  const end = value.lastIndexOf('"]');
  return end < start
    ? value.slice(0, start)
    : value.slice(0, start) + value.slice(end + 2);
}

function scrubAttribute(value: string): string {
  // Page and API URLs carry search text in the query string.
  if (/^https?:\/\//.test(value)) return value.split(/[?#]/, 1)[0] ?? value;
  return scrubSelector(value);
}

// Browser span names are fixed labels such as "Click" or "GET localhost". The
// page content they describe is in their attributes.
function scrubSpan(span: StreamedSpanJSON): StreamedSpanJSON {
  for (const key of QUERY_ATTRIBUTE_KEYS) {
    delete span.attributes[key];
  }
  for (const [key, value] of Object.entries(span.attributes)) {
    if (typeof value === "string") {
      span.attributes[key] = scrubAttribute(value);
    }
  }
  return span;
}

/**
 * Send dashboard performance spans to the server's Sentry project when the
 * server provides a DSN. Only tracing is enabled: error events and
 * breadcrumbs could carry conversation content shown on the page.
 */
export function initDashboardSentry(): void {
  const config = window.__JUNIOR_DASHBOARD_SENTRY__;
  if (!config) return;
  init({
    ...config,
    beforeSendSpan: scrubSpan,
    defaultIntegrations: false,
    integrations: [browserTracingIntegration()],
  });
}
