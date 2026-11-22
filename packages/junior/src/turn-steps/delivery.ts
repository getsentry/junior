// Delivers the replies of core Turns on this deployment: the queue consumer of
// delivery messages, with a sender for each Location provider.
import type { SlackAdapter } from "@chat-adapter/slack";
import { getSqlExecutor } from "@/chat/db";
import { createSlackSystemTurnDelivery } from "@/chat/providers/slack/system-turn";
import { deliverTurn, type DeliverySenders } from "@/core/delivery/deliver";
import { createDeliveryConsumer } from "@/core/delivery/queue";

/**
 * The queue consumer of delivery messages. Build it after `createApp` sets
 * the runtime config, because the visibility timeout reads
 * `functionMaxDurationSeconds`.
 */
export function deliveryConsumer(args: {
  getSlackAdapter: () => SlackAdapter;
}) {
  // The senders' provider conversation bindings are not stored yet.
  const senders: DeliverySenders = {
    slack: createSlackSystemTurnDelivery({
      getSlackAdapter: args.getSlackAdapter,
    }),
  };
  return createDeliveryConsumer((message) =>
    deliverTurn(getSqlExecutor(), message, senders),
  );
}
