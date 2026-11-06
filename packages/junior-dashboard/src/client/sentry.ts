import {
  BrowserClient,
  browserTracingIntegration,
  captureFeedback,
  defaultStackParser,
  getActiveSpan,
  getClient,
  getRootSpan,
  makeFetchTransport,
  setCurrentClient,
  spanToJSON,
  startInactiveSpan,
  updateSpanName,
  type BrowserOptions,
  type Span,
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
 * Time from navigation start to the fetch of the page document. Sign-in
 * redirects through the identity provider land here, and cross-origin
 * redirects get no redirect timing of their own.
 */
function preFetchMs(): number | undefined {
  const [entry] = performance.getEntriesByType?.("navigation") ?? [];
  return entry
    ? Math.round((entry as PerformanceNavigationTiming).fetchStart)
    : undefined;
}

/** The open pageload or navigation span, if the page has one. */
function activeRouteSpan(): Span | undefined {
  const activeSpan = getActiveSpan();
  if (!activeSpan) return undefined;
  const rootSpan = getRootSpan(activeSpan);
  const op = spanToJSON(rootSpan).attributes["sentry.op"];
  return op === "pageload" || op === "navigation" ? rootSpan : undefined;
}

/**
 * Name the open pageload or navigation span after the matched route pattern.
 * With span streaming, the SDK names these spans only `Pageload` and
 * `Navigation`.
 */
export function nameRouteSpan(pattern: string): void {
  const span = activeRouteSpan();
  if (!span) return;
  updateSpanName(span, pattern);
  span.setAttribute("sentry.segment.name.source", "route");
}

/**
 * Add a span from the start of the open pageload or navigation to the first
 * render of the Conversation transcript. The pageload or navigation span
 * ends only after every request on the page is idle, side panels and polls
 * included, so its duration is not the time to see the transcript.
 */
export function recordTranscriptShown(): void {
  const span = activeRouteSpan();
  if (!span) return;
  const { attributes, start_timestamp } = spanToJSON(span);
  startInactiveSpan({
    attributes: { "app.dashboard.load": attributes["sentry.op"] as string },
    name: "Conversation transcript shown",
    op: "ui.render",
    parentSpan: span,
    startTime: start_timestamp,
  }).end();
}

/**
 * Read, parse, and validate a dashboard API response body. While a pageload
 * or navigation is open, a span times it from the response headers to the
 * validated value. The `http.client` span ends at the headers, so it holds
 * none of this work.
 */
export async function readResponseJson<T>(
  response: Response,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  const routeSpan = activeRouteSpan();
  if (!routeSpan) return schema.parse(await response.json());
  const span = startInactiveSpan({
    attributes: {
      "url.path": response.url ? new URL(response.url).pathname : undefined,
    },
    name: "Read API response",
    op: "deserialize",
    parentSpan: routeSpan,
  });
  try {
    const text = await response.text();
    const downloadedAt = performance.now();
    const json: unknown = JSON.parse(text);
    const parsedAt = performance.now();
    const value = schema.parse(json);
    span.setAttributes({
      "app.dashboard.response.chars": text.length,
      "app.dashboard.response.json_parse_ms": Math.round(
        parsedAt - downloadedAt,
      ),
      "app.dashboard.response.schema_parse_ms": Math.round(
        performance.now() - parsedAt,
      ),
    });
    return value;
  } finally {
    span.end();
  }
}

/** A reader's rating of one Junior Reply. */
export type ReplyRating = "good" | "bad";

/** Whether the server gave the browser a DSN, so Reply ratings can be sent. */
export function canSendReplyRating(): boolean {
  return getClient() !== undefined;
}

/**
 * Send a reader's rating of one Junior Reply as Sentry user feedback. It
 * holds the rating and IDs only: no Reply text, page query, or person.
 */
export function sendReplyRating(props: {
  conversationId: string;
  messageId: string;
  rating: ReplyRating;
}): void {
  captureFeedback({
    message: props.rating === "good" ? "Good reply" : "Bad reply",
    source: "dashboard_reply_rating",
    tags: {
      "app.reply.rating": props.rating,
      "gen_ai.conversation.id": props.conversationId,
      "messaging.message.id": props.messageId,
    },
    url: `${window.location.origin}${window.location.pathname}`,
  });
}

/**
 * Send dashboard performance spans and Reply ratings to the server's Sentry
 * project when the server provides a DSN. Error events and breadcrumbs stay
 * off: they could carry conversation content shown on the page.
 */
export function initDashboardSentry(): void {
  const config = window.__JUNIOR_DASHBOARD_SENTRY__;
  if (!config) return;
  // `init()` bundles every default integration (about 24 KB of error,
  // breadcrumb, and session code), even with `defaultIntegrations: false`.
  // A client built directly bundles only browser tracing.
  const client = new BrowserClient({
    ...config,
    beforeSendSpan: scrubSpan,
    stackParser: defaultStackParser,
    transport: makeFetchTransport,
    integrations: [
      browserTracingIntegration({
        beforeStartSpan: (options) =>
          options.op === "pageload"
            ? {
                ...options,
                attributes: {
                  ...options.attributes,
                  "app.dashboard.navigation.pre_fetch_ms": preFetchMs(),
                },
              }
            : options,
      }),
    ],
  });
  setCurrentClient(client);
  client.init();
}
