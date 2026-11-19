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

type WithSpanOptions = {
  /**
   * Returns true for a throw that is a normal outcome, such as a timeout that
   * the caller handles. Only other throws set the error status.
   */
  isExpectedError?: (error: unknown) => boolean;
};

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
  return Sentry.startSpanManual(
    { name, op: name, attributes },
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
}
