// Delivers the replies of core Turns on this deployment: the queue consumer of
// delivery messages, with the Delivery that sends them.
import type { QueueConsumer } from "@/chat/queue/provider";
import { deliverTurn, type Delivery } from "@/core/delivery/deliver";
import { createDeliveryConsumer } from "@/core/delivery/queue";
import type { EngineContext } from "@/core/engine-context";

/**
 * The Delivery of this deployment. No Destination platform has a sender in
 * core yet, so each reply that has a Destination fails.
 */
export const deploymentDelivery: Delivery = {
  send: async ({ destination }) => {
    throw new Error(`No sender for ${destination.platform} Destinations`);
  },
};

/**
 * The queue consumer of delivery messages. The host mounts it on
 * `engineCtx.queue`.
 */
export function deliveryConsumer(
  engineCtx: EngineContext,
  delivery: Delivery,
): QueueConsumer {
  return createDeliveryConsumer(engineCtx, (message) =>
    deliverTurn(engineCtx, message, delivery),
  );
}
