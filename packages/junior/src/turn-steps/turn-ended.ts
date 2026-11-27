// Runs what follows a core Turn's end on this deployment: the queue consumer
// of the messages that a Turn ended, with the Delivery that sends its replies.
import type { SlackAdapter } from "@chat-adapter/slack";
import type { QueueConsumer } from "@/chat/queue/provider";
import type { EngineContext } from "@/core/engine-context";
import { readTurnEndedMessages } from "@/core/turn/ended";
import { deliverTurn, type Delivery } from "@/delivery/deliver";
import { createSlackSender } from "@/delivery/slack";
import { compat__writeTurnEnded } from "@/turn-steps/compat__turn-ended";
import { recordTurnMetrics } from "@/turn-steps/metrics";

/**
 * Creates the Delivery of this deployment. It sends replies to Slack
 * Destinations. Other platforms have no sender yet, so their replies fail.
 */
export function createDeploymentDelivery(args: {
  getSlackAdapter: () => SlackAdapter;
}): Delivery {
  const sendToSlack = createSlackSender(args);
  return {
    send: async (reply) => {
      const { destination } = reply;
      if (destination.platform === "slack") {
        return sendToSlack({ ...reply, destination });
      }
      throw new Error(`No sender for ${destination.platform} Destinations`);
    },
  };
}

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
    // Compat: main's end event comes after the replies it delivered.
    await compat__writeTurnEnded(engineCtx, message);
  });
}
