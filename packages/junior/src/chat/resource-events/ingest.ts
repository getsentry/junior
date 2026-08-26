import type { StateAdapter } from "chat";
import { resourceEventSchema } from "@sentry/junior-plugin-api";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { logWarn } from "@/chat/logging";
import {
  enqueueResourceEventNotification,
  resolveResourceEventDeliveryRoute,
} from "@/chat/resource-events/notification";
import {
  cancelResourceEventSubscription,
  deliverResourceEventSubscription,
  findMatchingResourceEventSubscriptions,
} from "@/chat/resource-events/store";

/** Match a normalized resource event and enqueue notifications into conversations. */
export async function ingestResourceEvent(
  input: unknown,
  options: {
    nowMs?: number;
    queue: ConversationWorkQueue;
    state?: StateAdapter;
    teamId: string;
  },
): Promise<{ enqueued: number }> {
  const event = resourceEventSchema.parse(input);
  const nowMs = options.nowMs ?? Date.now();
  const subscriptions = await findMatchingResourceEventSubscriptions({
    data: event.data,
    eventType: event.eventType,
    nowMs,
    namespace: event.namespace,
    identifier: event.identifier,
    state: options.state,
    teamId: options.teamId,
  });
  let enqueued = 0;
  const errors: unknown[] = [];
  const waitDeadlineMs = Date.now() + 10_000;
  for (const subscription of subscriptions) {
    try {
      const route = await resolveResourceEventDeliveryRoute({
        conversationId: subscription.conversationId,
        teamId: subscription.teamId,
      });
      if (!route) {
        logWarn("resource_event.subscription.undeliverable", {
          "app.resource_event.subscription_id": subscription.id,
          "app.resource_event.conversation_id": subscription.conversationId,
          "app.resource_event.namespace": subscription.namespace,
          "app.resource_event.identifier": subscription.identifier,
          "app.resource_event.reason": "missing_destination_route",
        });
        await cancelResourceEventSubscription({
          conversationId: subscription.conversationId,
          id: subscription.id,
          nowMs,
          state: options.state,
        });
        continue;
      }
      const delivered = await deliverResourceEventSubscription({
        data: event.data,
        eventType: event.eventType,
        namespace: event.namespace,
        identifier: event.identifier,
        teamId: options.teamId,
        terminal: event.terminal,
        nowMs,
        state: options.state,
        subscription,
        waitDeadlineMs,
        deliver: async (current) => {
          const result = await enqueueResourceEventNotification({
            event,
            queue: options.queue,
            state: options.state,
            subscription: current,
          });
          return result.status === "appended";
        },
      });
      if (delivered) {
        enqueued += 1;
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Failed to deliver one or more resource event subscriptions",
    );
  }
  return { enqueued };
}
