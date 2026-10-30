import {
  withSpan,
  type LogContext,
  type SetSpanAttributes,
} from "@/chat/logging";
import { continueTrace, getActiveSpan } from "@/chat/sentry";
import type { TraceContext } from "@/chat/task-execution/state";

/** Mailbox timing facts for the input messages that start a Slack turn. */
export interface SlackTurnInputTelemetry {
  /** Input messages in the batch that starts the turn. */
  count: number;
  /** Slack send time of the oldest input message. */
  oldestCreatedAtMs: number;
  /** Webhook receipt time of the oldest input message. */
  oldestReceivedAtMs: number;
  /** Ingress trace contexts of the input messages, oldest first. */
  traceContexts: TraceContext[];
}

const SENTRY_TRACE_PATTERN = /^([0-9a-f]{32})-([0-9a-f]{16})(?:-([01]))?$/;

function spanLinks({ sentryTrace }: TraceContext) {
  const [, traceId, spanId, sampled] =
    SENTRY_TRACE_PATTERN.exec(sentryTrace) ?? [];
  return traceId && spanId
    ? [{ context: { traceId, spanId, traceFlags: sampled === "1" ? 1 : 0 } }]
    : [];
}

/**
 * Run a `chat.turn` span in the trace of the first trace context.
 *
 * The span links to the other trace contexts and to the span that was active,
 * such as the worker span. Without a trace context, the span is a child of the
 * active span. A malformed trace context starts a new trace.
 */
export async function withTurnSpan<T>(
  context: LogContext,
  input: Pick<SlackTurnInputTelemetry, "traceContexts"> | undefined,
  callback: (setSpanAttributes: SetSpanAttributes) => Promise<T>,
): Promise<T> {
  const [parent, ...others] = input?.traceContexts ?? [];
  if (!parent) {
    return await withSpan("chat.turn", "chat.turn", context, callback);
  }
  const activeSpan = getActiveSpan();
  const links = [
    ...others.flatMap(spanLinks),
    ...(activeSpan ? [{ context: activeSpan.spanContext() }] : []),
  ];
  const { baggage, sentryTrace } = parent;
  return await continueTrace({ baggage, sentryTrace }, () =>
    withSpan("chat.turn", "chat.turn", context, async (setSpanAttributes) => {
      getActiveSpan()?.addLinks(links);
      return await callback(setSpanAttributes);
    }),
  );
}

/**
 * Build the `chat.turn` timing attributes for the oldest input message.
 *
 * Slack, the webhook host, and the worker host use separate clocks. A negative
 * duration is clock skew, not latency, so it is left out.
 */
export function getTurnInputSpanAttributes(
  input: SlackTurnInputTelemetry,
  turnStartedAtMs: number,
): Record<string, number> {
  const attributes: Record<string, number> = {
    "app.turn.input_count": input.count,
  };
  const deliveryLagMs = input.oldestReceivedAtMs - input.oldestCreatedAtMs;
  if (deliveryLagMs >= 0) {
    attributes["app.turn.delivery_lag_ms"] = Math.round(deliveryLagMs);
  }
  const waitMs = turnStartedAtMs - input.oldestReceivedAtMs;
  if (waitMs >= 0) {
    attributes["app.turn.wait_ms"] = Math.round(waitMs);
  }
  return attributes;
}
