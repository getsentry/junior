// Runs what follows a core Turn's end on this deployment: the queue consumer
// of the messages that a Turn ended, with the Delivery that sends its replies.
import type { QueueConsumer } from "@/chat/queue/provider";
import type { EngineContext } from "@/core/engine-context";
import { readTurnEndedMessages } from "@/core/turn/ended";
import { deliverTurn, type Delivery } from "@/delivery/deliver";
import { recordTurnMetrics } from "@/turn-steps/metrics";

/**
 * The Delivery of this deployment. No Destination platform has a sender yet,
 * so each reply that has a Destination fails.
 */
export const deploymentDelivery: Delivery = {
  send: async ({ destination }) => {
    throw new Error(`No sender for ${destination.platform} Destinations`);
  },
};

/**
 * The queue consumer of the messages that a Turn ended. It records the Turn's
 * metrics, then sends its replies, so a send that waits does not hold back
 * the spend. The host mounts it on `engineCtx.queue`.
 */
export function turnEndedConsumer(
  engineCtx: EngineContext,
  delivery: Delivery,
): QueueConsumer {
  return readTurnEndedMessages(engineCtx, async (message) => {
    await recordTurnMetrics(engineCtx, message);
    await deliverTurn(engineCtx, message, delivery);
  });
}
