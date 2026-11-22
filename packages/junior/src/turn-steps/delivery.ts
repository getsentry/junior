// Delivers the replies of core Turns on this deployment: the queue consumer of
// delivery messages, with a sender for each Location provider.
import type { SlackAdapter } from "@chat-adapter/slack";
import { RetryableDeliveryError } from "@/chat/agent/types";
import { getSqlExecutor } from "@/chat/db";
import { createSlackSystemTurnDelivery } from "@/chat/providers/slack/system-turn";
import { SlackActionError } from "@/chat/slack/client";
import {
  DeliveryRetryableError,
  deliverTurn,
  type DeliverySender,
  type DeliverySenders,
} from "@/core/delivery/deliver";
import { createDeliveryConsumer } from "@/core/delivery/queue";

/**
 * The queue consumer of delivery messages. Build it after `createApp` sets
 * the runtime config, because the visibility timeout reads
 * `functionMaxDurationSeconds`.
 */
export function deliveryConsumer(args: {
  getSlackAdapter: () => SlackAdapter;
}) {
  const senders: DeliverySenders = {
    slack: slackSender(args.getSlackAdapter),
  };
  return createDeliveryConsumer((message) =>
    deliverTurn(getSqlExecutor(), message, senders),
  );
}

/**
 * Sends replies with the Slack system Turn delivery. A retryable Slack
 * failure becomes core's retryable error, with the Retry-After of a rate
 * limit. The provider conversation bindings that it returns are not stored
 * yet.
 */
function slackSender(getSlackAdapter: () => SlackAdapter): DeliverySender {
  const send = createSlackSystemTurnDelivery({ getSlackAdapter });
  return async (input) => {
    try {
      return await send(input);
    } catch (error) {
      if (!(error instanceof RetryableDeliveryError)) {
        throw error;
      }
      const { cause } = error;
      const retryAfterSeconds =
        cause instanceof SlackActionError ? cause.retryAfterSeconds : undefined;
      throw new DeliveryRetryableError(
        cause instanceof Error ? cause.message : error.message,
        {
          cause: error,
          retryAfterMs: retryAfterSeconds
            ? retryAfterSeconds * 1000
            : undefined,
        },
      );
    }
  };
}
