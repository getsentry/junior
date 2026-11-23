// The queue message that delivers a Turn's replies. It holds only the
// Conversation and the Turn: the outbox rows own what is sent and what is
// left, so a message sent twice or late sends no reply twice.
import * as z from "zod";
import { logWarn } from "@/chat/logging";
import { queueCallback } from "@/chat/queue/callback";
import type {
  QueueConsumer,
  QueueMessageMetadata,
} from "@/chat/queue/provider";
import {
  QUEUE_SIGNATURE_MAX_AGE_MS,
  signQueueMessage,
  verifyQueueMessage,
} from "@/chat/queue/sign";
import type { EngineContext } from "@/core/engine-context";
import { activeTraceContext, withSpan } from "@/core/telemetry";

/** Queue topic of delivery messages. */
export const DELIVERY_TOPIC = "junior_delivery";

const DELIVERY_CONSUMER_GROUP = "junior_delivery";

// A delivery sends while it holds a transaction, and the host stops it at the
// function's max duration. The queue sends the message again only after that.
const VISIBILITY_TIMEOUT_BUFFER_SECONDS = 30;

const deliveryMessageSchema = z
  .object({
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
    traceContext: z
      .object({ sentryTrace: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

type SignedDeliveryMessage = z.output<typeof deliveryMessageSchema>;

/** The Conversation and the Turn whose replies a delivery message sends. */
export type DeliveryMessage = { conversationId: string; turnId: string };

const deliverySign = {
  context: "junior.delivery.v1",
  schema: deliveryMessageSchema,
  signatureVersion: "v1" as const,
  parts: (message: SignedDeliveryMessage) => [
    message.conversationId,
    message.turnId,
    message.traceContext?.sentryTrace ?? "",
  ],
};

/** Sends a message that delivers the Turn's replies, after `delayMs` if set. */
export async function publishDelivery(
  { queue }: Pick<EngineContext, "queue">,
  message: DeliveryMessage,
  options: { delayMs?: number } = {},
): Promise<void> {
  await withSpan(
    "queue.publish",
    {
      "app.turn.id": message.turnId,
      "gen_ai.conversation.id": message.conversationId,
      "messaging.destination.name": DELIVERY_TOPIC,
      "messaging.system": queue.messagingSystem,
    },
    async (span) => {
      const traceContext = activeTraceContext();
      const payload = signQueueMessage(
        deliverySign,
        traceContext ? { ...message, traceContext } : message,
      );
      // The queue sends the payload as these UTF-8 JSON bytes.
      span.setAttribute(
        "messaging.message.body.size",
        Buffer.byteLength(JSON.stringify(payload)),
      );
      const result = await queue.send(DELIVERY_TOPIC, payload, {
        delaySeconds:
          options.delayMs && options.delayMs > 0
            ? Math.ceil(options.delayMs / 1000)
            : undefined,
        // A message older than its signature is rejected, so the queue drops it.
        retentionSeconds: QUEUE_SIGNATURE_MAX_AGE_MS / 1000,
      });
      if (result.messageId) {
        span.setAttribute("messaging.message.id", result.messageId);
      }
    },
  );
}

/** Runs one delivery message inside the `queue.process` span. */
export type RunDelivery = (
  message: DeliveryMessage,
  metadata: QueueMessageMetadata,
) => Promise<void>;

/**
 * Builds the queue consumer of delivery messages. It acknowledges a message
 * with a bad or expired signature and retries one that cannot be checked yet.
 * The host mounts it on its queue provider.
 */
export function createDeliveryConsumer(
  { queue, leaseMs }: Pick<EngineContext, "queue" | "leaseMs">,
  run: RunDelivery,
): QueueConsumer {
  const { consumer } = queueCallback<SignedDeliveryMessage>({
    consumerGroup: DELIVERY_CONSUMER_GROUP,
    // The outbox rows hold the delivery state, so a retry only sends what is
    // left.
    maxDeliveries: null,
    onRejected: (reason, metadata) => {
      logWarn("turn.delivery.queue_message.rejected", {
        "app.queue.consumer_group": metadata.consumerGroup,
        "app.queue.delivery_count": metadata.deliveryCount,
        "app.queue.message_id": metadata.messageId,
        "app.queue.reject_reason": reason,
        "app.queue.topic_name": metadata.topicName,
      });
    },
    run: (message, metadata) =>
      withSpan(
        "queue.process",
        {
          "app.turn.id": message.turnId,
          "gen_ai.conversation.id": message.conversationId,
          "messaging.destination.name": metadata.topicName,
          "messaging.system": queue.messagingSystem,
          "messaging.message.id": metadata.messageId,
          "messaging.message.receive.latency":
            Date.now() - metadata.createdAt.getTime(),
          "messaging.message.retry.count": metadata.deliveryCount - 1,
        },
        () =>
          run(
            { conversationId: message.conversationId, turnId: message.turnId },
            metadata,
          ),
        {
          links: message.traceContext ? [message.traceContext] : [],
          newTrace: true,
        },
      ),
    topic: DELIVERY_TOPIC,
    verify: (value) => verifyQueueMessage(deliverySign, value),
    visibilityTimeoutSeconds:
      leaseMs / 1000 + VISIBILITY_TIMEOUT_BUFFER_SECONDS,
  });
  return consumer;
}
