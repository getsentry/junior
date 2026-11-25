// The queue message that delivers a Turn's replies. It holds only the
// Conversation and the Turn: the outbox rows own what is sent and what is
// left, so a message sent twice or late sends no reply twice.
import * as z from "zod";
import { logWarn } from "@/chat/logging";
import type {
  QueueConsumer,
  QueueMessageMetadata,
} from "@/chat/queue/provider";
import { DELIVERY_TOPIC } from "@/core/delivery/topic";
import type { EngineContext } from "@/core/engine-context";
import { signedTopic } from "@/core/queue";

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

/** The Conversation and the Turn whose replies a delivery message sends. */
export type DeliveryMessage = { conversationId: string; turnId: string };

const deliveryTopic = signedTopic<DeliveryMessage>({
  topic: DELIVERY_TOPIC,
  sign: {
    context: "junior.delivery.v1",
    schema: deliveryMessageSchema,
    signatureVersion: "v1",
    parts: (message) => [
      message.conversationId,
      message.turnId,
      message.traceContext?.sentryTrace ?? "",
    ],
  },
  onRejected: (attributes) =>
    logWarn("turn.delivery.queue_message.rejected", attributes),
  attributes: (message) => ({
    "app.turn.id": message.turnId,
    "gen_ai.conversation.id": message.conversationId,
  }),
});

/** Sends a message that delivers the Turn's replies, after `delayMs` if set. */
export async function publishDelivery(
  ctx: Pick<EngineContext, "queue">,
  message: DeliveryMessage,
  options: { delayMs?: number } = {},
): Promise<void> {
  await deliveryTopic.publish(ctx, message, options);
}

/** Runs one delivery message inside the `queue.process` span. */
export type RunDelivery = (
  message: DeliveryMessage,
  metadata: QueueMessageMetadata,
) => Promise<void>;

/**
 * Builds the queue consumer of delivery messages. It acknowledges a message
 * with a bad or expired signature and retries one that cannot be checked yet.
 * The outbox rows hold the delivery state, so a retry only sends what is
 * left. The host mounts the consumer on its queue provider.
 */
export function createDeliveryConsumer(
  ctx: Pick<EngineContext, "queue" | "leaseMs">,
  run: RunDelivery,
): QueueConsumer {
  return deliveryTopic.consumer(ctx, (message, metadata) =>
    run(
      { conversationId: message.conversationId, turnId: message.turnId },
      metadata,
    ),
  );
}
