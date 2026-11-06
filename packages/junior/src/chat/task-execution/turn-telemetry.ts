import {
  withSpan,
  type LogContext,
  type SetSpanAttributes,
} from "@/chat/logging";
import { continueTrace, getActiveSpan } from "@/chat/sentry";
import { measureTurnCompactionWait } from "@/chat/services/context-compaction-telemetry";
import type { InboundMessage, TraceContext } from "@/chat/task-execution/state";

/** Mailbox timing facts for the input messages that start a Turn. */
export interface TurnInputTelemetry {
  /** Input messages in the batch that starts the turn. */
  count: number;
  /** Send time of the oldest input message, such as its Slack timestamp. */
  oldestCreatedAtMs: number;
  /** Ingress receipt time of the oldest input message. */
  oldestReceivedAtMs: number;
  /** Ingress trace contexts of the input messages, oldest first. */
  traceContexts: TraceContext[];
}

/** Read the turn input timing facts from a mailbox batch, oldest first. */
export function turnInputTelemetry(
  messages: readonly InboundMessage[],
): TurnInputTelemetry | undefined {
  const oldest = messages[0];
  if (!oldest) return undefined;
  return {
    count: messages.length,
    oldestCreatedAtMs: oldest.createdAtMs,
    oldestReceivedAtMs: oldest.receivedAtMs,
    traceContexts: messages.flatMap((message) => message.traceContext ?? []),
  };
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
 * active span. A malformed trace context starts a new trace. The span records
 * how long the Turn waited on context compaction.
 */
export async function withTurnSpan<T>(
  context: LogContext,
  input: Pick<TurnInputTelemetry, "traceContexts"> | undefined,
  callback: (setSpanAttributes: SetSpanAttributes) => Promise<T>,
): Promise<T> {
  const [parent, ...others] = input?.traceContexts ?? [];
  if (!parent) {
    return await withSpan("chat.turn", "chat.turn", context, (set) =>
      measureTurnCompactionWait(set, () => callback(set)),
    );
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
      return await measureTurnCompactionWait(setSpanAttributes, () =>
        callback(setSpanAttributes),
      );
    }),
  );
}

/**
 * Build the `chat.turn` timing attributes for the oldest input message.
 *
 * The provider, the ingress host, and the worker host use separate clocks. A negative
 * duration is clock skew, not latency, so it is left out.
 */
export function getTurnInputSpanAttributes(
  input: TurnInputTelemetry,
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
