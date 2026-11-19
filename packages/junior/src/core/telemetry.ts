// Core's only import of the Sentry SDK. Core code records telemetry through
// this file. Span and attribute names match the ones in TELEMETRY.md, so
// existing queries keep working.
//
// Core may import the chat modules that own shared state, such as the
// Conversation history writer, but never chat's Turn engine, which core
// replaces.
import * as Sentry from "@sentry/node";

/** Attribute values a span accepts. `undefined` values are not recorded. */
export type SpanAttributes = Record<
  string,
  string | number | boolean | undefined
>;

/** The part of a span that core code may change. */
export type Span = {
  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attributes: SpanAttributes): void;
};

/** Trace propagation headers of one span, as sent with work to another host. */
type TraceContext = { sentryTrace: string; baggage?: string };

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
  const { "sentry-trace": sentryTrace, baggage } = Sentry.getTraceData();
  if (!sentryTrace) {
    return undefined;
  }
  return baggage ? { sentryTrace, baggage } : { sentryTrace };
}

// OpenTelemetry status code for an error.
const SPAN_STATUS_ERROR = 2;

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
