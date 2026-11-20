// Core's only import of the Sentry SDK. Core code records telemetry through
// this file. Span and attribute names match the ones in TELEMETRY.md, so
// existing queries keep working.
//
// Core may import the chat modules that own shared state, such as the
// Conversation history writer, but never chat's Turn engine, which core
// replaces.
import * as Sentry from "@sentry/node";

/** A value that a span attribute accepts. */
export type SpanAttributeValue = string | number | boolean | string[];

/** Attribute values a span accepts. `undefined` values are not recorded. */
export type SpanAttributes = Record<string, SpanAttributeValue | undefined>;

/** The part of a span that core code may change. */
export type Span = {
  setAttribute(key: string, value: SpanAttributeValue): void;
  setAttributes(attributes: SpanAttributes): void;
};

/**
 * A span that outlives the call that starts it, such as the span of a
 * streamed model reply. Its owner must call `end`.
 */
export type OpenSpan = Span & {
  /** Runs `run` with this span active, so work that `run` starts nests under it. */
  activate<T>(run: () => T): T;
  /** Sets the error status. */
  fail(message: string): void;
  end(): void;
};

/** The `sentry-trace` header of one span, as sent with work to another host. */
type TraceContext = { sentryTrace: string };

type WithSpanOptions = {
  /**
   * Returns true for a throw that is a normal outcome, such as a timeout that
   * the caller handles. Only other throws set the error status.
   */
  isExpectedError?: (error: unknown) => boolean;
  /** Spans in other traces that caused this one. The span stays in its own trace. */
  links?: readonly TraceContext[];
  /** Starts the span in a new trace, even under an active span. */
  newTrace?: boolean;
};

const SENTRY_TRACE_PATTERN = /^([0-9a-f]{32})-([0-9a-f]{16})(?:-([01]))?$/;

function spanLink({ sentryTrace }: TraceContext) {
  const [, traceId, spanId, sampled] =
    SENTRY_TRACE_PATTERN.exec(sentryTrace) ?? [];
  return traceId && spanId
    ? [{ context: { traceId, spanId, traceFlags: sampled === "1" ? 1 : 0 } }]
    : [];
}

/** Returns the trace context of the active span, so other work can link to it. */
export function activeTraceContext(): TraceContext | undefined {
  const sentryTrace = Sentry.getTraceData()["sentry-trace"];
  return sentryTrace ? { sentryTrace } : undefined;
}

/** Sets attributes on the active span, such as ids that a step learns late. */
export function setActiveSpanAttributes(attributes: SpanAttributes): void {
  Sentry.getActiveSpan()?.setAttributes(attributes);
}

// OpenTelemetry status code for an error.
const SPAN_STATUS_ERROR = 2;

/** Starts a span that is not active. Its owner ends it. */
export function openSpan(
  name: string,
  op: string,
  attributes: SpanAttributes,
): OpenSpan {
  const span = Sentry.startInactiveSpan({ name, op, attributes });
  return {
    setAttribute: (key, value) => span.setAttribute(key, value),
    setAttributes: (values) => span.setAttributes(values),
    activate: (run) => Sentry.withActiveSpan(span, run),
    fail: (message) => span.setStatus({ code: SPAN_STATUS_ERROR, message }),
    end: () => span.end(),
  };
}

/** Runs `run` in a span named `name`, which is also its op. */
export function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  run: (span: Span) => Promise<T>,
  options: WithSpanOptions = {},
): Promise<T> {
  // startSpanManual, not startSpan: startSpan sets the error status on every
  // throw, including expected ones.
  const start = () =>
    Sentry.startSpanManual(
      { name, op: name, attributes, links: options.links?.flatMap(spanLink) },
      async (span) => {
        try {
          return await run(span);
        } catch (error) {
          if (!options.isExpectedError?.(error)) {
            span.setStatus({
              code: SPAN_STATUS_ERROR,
              message: "internal_error",
            });
            span.setAttribute(
              "error.type",
              error instanceof Error ? error.name : typeof error,
            );
          }
          throw error;
        } finally {
          span.end();
        }
      },
    );
  return options.newTrace ? Sentry.startNewTrace(start) : start();
}
