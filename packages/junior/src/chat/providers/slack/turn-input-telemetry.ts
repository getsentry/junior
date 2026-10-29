/** Mailbox timing facts for the input messages that start a Slack turn. */
export interface SlackTurnInputTelemetry {
  /** Input messages in the batch that starts the turn. */
  count: number;
  /** Slack send time of the oldest input message. */
  oldestCreatedAtMs: number;
  /** Webhook receipt time of the oldest input message. */
  oldestReceivedAtMs: number;
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
