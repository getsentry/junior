// Delivers the replies of core Turns on this deployment: the queue consumer of
// delivery messages, with the sender of each Destination platform.
import type { SlackAdapter } from "@chat-adapter/slack";
import { RetryableDeliveryError } from "@/chat/agent/types";
import { isConversationDeliveryPaused } from "@/chat/conversations/delivery-pause";
import type { QueueConsumer } from "@/chat/queue/provider";
import { postSlackSystemReply } from "@/chat/providers/slack/system-turn";
import { SlackActionError } from "@/chat/slack/client";
import {
  DeliveryRetryableError,
  deliverTurn,
  type Delivery,
} from "@/core/delivery/deliver";
import { createDeliveryConsumer } from "@/core/delivery/queue";
import type { EngineContext } from "@/core/engine-context";

/**
 * The queue consumer of delivery messages. The host mounts it on
 * `engineCtx.queue`.
 */
export function deliveryConsumer(
  engineCtx: EngineContext,
  args: { getSlackAdapter: () => SlackAdapter },
): QueueConsumer {
  const delivery: Delivery = {
    send: async ({ conversationId, destination, text }) => {
      if (destination.platform !== "slack") {
        throw new Error(`No sender for ${destination.platform} Destinations`);
      }
      const messageIds = await sendRetryable(() =>
        postSlackSystemReply(args, {
          conversationId,
          target: destination,
          text,
        }),
      );
      const providerMessageId = messageIds.at(-1);
      return providerMessageId ? { providerMessageId } : {};
    },
    isPaused: (conversationId) =>
      isConversationDeliveryPaused(conversationId, engineCtx.executor),
  };
  return createDeliveryConsumer(engineCtx, (message) =>
    deliverTurn(engineCtx, message, delivery),
  );
}

/**
 * Turns a retryable Slack failure into core's retryable error, with the
 * Retry-After of a rate limit.
 */
async function sendRetryable<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
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
        retryAfterMs: retryAfterSeconds ? retryAfterSeconds * 1000 : undefined,
      },
    );
  }
}
