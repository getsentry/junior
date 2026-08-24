import type { StateAdapter } from "chat";
import { resourceEventSchema } from "@sentry/junior-plugin-api";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { enqueueResourceEventNotification } from "@/chat/resource-events/notification";
import {
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
