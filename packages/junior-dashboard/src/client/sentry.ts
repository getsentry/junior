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
// attribute values, such as a conversation title in an `aria-label`. A value
// ends where the next selector part or element starts.
const ELEMENT_ATTRIBUTE =
  /\[(?:aria-label|type|name|title|alt)=".*?"\](?=\[|\s>\s|$)/g;

function scrubAttribute(value: string): string {
  // Page and API URLs carry search text in the query string.
  if (/^https?:\/\//.test(value)) return value.split(/[?#]/, 1)[0] ?? value;
  return value.replace(ELEMENT_ATTRIBUTE, "");
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
