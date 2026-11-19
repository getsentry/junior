import {
  BrowserClient,
  browserTracingCoreIntegration,
  captureFeedback,
  defaultStackParser,
  fetchTracingIntegration,
  getActiveSpan,
  getClient,
  getIsolationScope,
  getRootSpan,
  linkedTracesIntegration,
  longTasksIntegration,
  makeFetchTransport,
  setCurrentClient,
  spanToJSON,
  startInactiveSpan,
  updateSpanName,
  type BrowserOptions,
  type Span,
} from "@sentry/browser";
import type { BrowserSentryConfig } from "@sentry/junior/instrumentation";
import {
  DASHBOARD_VERSION_DRIFT_MESSAGE,
  dashboardServerVersion,
  dashboardVersionDrift,
} from "./dashboard-version";
import type { UiShell } from "./uiShell";

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
// Element selectors in interaction, web vital, and long animation frame
// invoker attributes include these attribute values, such as a conversation
// title in an `aria-label` or an image URL in a `src`. The SDK does not escape
// quotes in values, so a value can contain `"]` and fake selector parts.
// Cutting from the first marker to the last `"]` removes every value, at the
// cost of the selector parts between them.
const ELEMENT_ATTRIBUTE_START = /\[(?:aria-label|type|name|title|alt|src)="/;

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
  if (value.startsWith("https://") || value.startsWith("http://")) {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
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

// Response schemas are strict, so a tab that still runs an older bundle can
// reject a field that a newer server added. Name that cause, not the schema
// issues. The version drift banner offers the refresh.
function parseResponseValue<T>(
  response: Response,
  schema: { parse: (value: unknown) => T },
  value: unknown,
): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (!dashboardVersionDrift(dashboardServerVersion(response))) throw error;
    throw new Error(DASHBOARD_VERSION_DRIFT_MESSAGE, { cause: error });
  }
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
  if (!routeSpan) {
    return parseResponseValue(response, schema, await response.json());
  }
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
    const value = parseResponseValue(response, schema, json);
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

/**
 * Record the change tokens that moved on one versions poll, so the poll
 * that refreshes a read shows which token caused it, and which feed-row
 * inputs moved the feed token. A poll that moves no token adds no span.
 */
export function recordMovedVersions(
  moved: readonly string[],
  feedMoved: readonly string[],
): void {
  if (moved.length === 0) return;
  startInactiveSpan({
    attributes: {
      "app.dashboard.versions.moved": moved.join(","),
      ...(feedMoved.length > 0
        ? { "app.dashboard.versions.feed_moved": feedMoved.join(",") }
        : undefined),
    },
    name: "Refresh changed reads",
    op: "function",
  }).end();
}

/** A reader's rating of one Junior Reply. */
export type ReplyRating = "good" | "bad";

/** What feedback from the Send feedback dialog is about. */
export type FeedbackTopic = "agent" | "new_ui";

/**
 * One reader feedback: a rating of one Junior Reply, or feedback from the
 * Send feedback dialog about the agent or the new UI.
 */
type DashboardFeedback =
  | {
      conversationId: string;
      kind: "reply_rating";
      messageId: string;
      rating: ReplyRating;
    }
  | { kind: "general"; topic: FeedbackTopic };

/** Whether the server gave the browser a DSN, so feedback can be sent. */
export function canSendFeedback(): boolean {
  return getClient() !== undefined;
}

/**
 * Send one reader feedback as Sentry user feedback, with the reader's name
 * and email and their comment. It holds no Reply text or page query.
 */
export function sendFeedback(
  props: DashboardFeedback & {
    comment?: string;
    reader?: { email: string; name?: string | null };
  },
): void {
  const { comment, reader } = props;
  const fields =
    props.kind === "general"
      ? {
          label: undefined,
          source: "dashboard_feedback",
          tags: { "app.feedback.topic": props.topic },
        }
      : {
          label: props.rating === "good" ? "Good reply" : "Bad reply",
          source: "dashboard_reply_rating",
          tags: {
            "app.reply.rating": props.rating,
            "gen_ai.conversation.id": props.conversationId,
            "messaging.message.id": props.messageId,
          },
        };
  captureFeedback({
    email: reader?.email,
    message: [fields.label, comment].filter(Boolean).join(": "),
    name: reader?.name || undefined,
    source: fields.source,
    tags: fields.tags,
    url: `${window.location.origin}${window.location.pathname}`,
  });
}

/**
 * Add `http.response.body.size`, the compressed body size from resource
 * timing, to each fetch span. Vercel compresses at the edge, so the server
 * sees only the uncompressed size. The SDK ends a fetch span when its
 * resource timing entry arrives, from a microtask of its own resource
 * observer. This observer must start before that one, so its callback sets
 * the size while the span is still open.
 */
function trackResponseBodySize(): {
  onSpanEnd: (span: Span) => void;
  onRequestSpanStart: (span: Span) => void;
} {
  // Fetch spans that wait for their resource timing entry, by URL.
  const pending = new Map<string, Span[]>();
  const remove = (url: string, span: Span) => {
    const spans = pending.get(url)?.filter((item) => item !== span);
    if (spans?.length) pending.set(url, spans);
    else pending.delete(url);
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const span = pending.get(entry.name)?.[0];
        if (!span || !(entry instanceof PerformanceResourceTiming)) continue;
        if (entry.initiatorType !== "fetch") continue;
        remove(entry.name, span);
        span.setAttribute("http.response.body.size", entry.encodedBodySize);
      }
    }).observe({ type: "resource" });
  } catch {
    // This browser has no resource timing. Fetch spans keep no size.
    return { onRequestSpanStart: () => {}, onSpanEnd: () => {} };
  }
  return {
    onRequestSpanStart: (span) => {
      const url = spanToJSON(span).attributes["url.full"];
      if (typeof url !== "string") return;
      pending.set(url, [...(pending.get(url) ?? []), span]);
    },
    // A span whose entry never arrives ends after the SDK's wait.
    onSpanEnd: (span) => {
      const url = spanToJSON(span).attributes["url.full"];
      if (typeof url === "string") remove(url, span);
    },
  };
}

/**
 * Send dashboard performance spans and reader feedback to the server's Sentry
 * project when the server provides a DSN. Error events and breadcrumbs stay
 * off: they could carry conversation content shown on the page. Every span
 * and feedback names the UI shell in `app.dashboard.ui`.
 */
export function initDashboardSentry(ui: UiShell): void {
  const config = window.__JUNIOR_DASHBOARD_SENTRY__;
  if (!config) return;
  // Feedback reads scope tags, and streamed spans read scope attributes.
  const scope = getIsolationScope();
  scope.setTag("app.dashboard.ui", ui);
  scope.setAttribute("app.dashboard.ui", ui);
  // Starts before the client, so before the SDK's resource observer.
  const bodySize = trackResponseBodySize();
  // `init()` bundles every default integration (about 24 KB of error,
  // breadcrumb, and session code), even with `defaultIntegrations: false`.
  // A client built directly bundles only the integrations listed here.
  // `browserTracingIntegration` would also bundle web vitals, XHR, and
  // resource spans.
  const client = new BrowserClient({
    ...config,
    beforeSendSpan: scrubSpan,
    stackParser: defaultStackParser,
    transport: makeFetchTransport,
    integrations: [
      browserTracingCoreIntegration({
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
      fetchTracingIntegration({
        onRequestSpanStart: bodySize.onRequestSpanStart,
      }),
      linkedTracesIntegration(),
      longTasksIntegration(),
    ],
  });
  client.on("spanEnd", bodySize.onSpanEnd);
  setCurrentClient(client);
  client.init();
}
