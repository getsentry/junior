import type { StateAdapter } from "chat";
import { eventSchema } from "@sentry/junior-plugin-api";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { enqueueEventNotification } from "@/chat/events/notification";
import { deliverWatch, findMatchingWatches } from "@/chat/events/store";

/** Match a normalized event and enqueue notifications into conversations. */
export async function ingestEvent(
  input: unknown,
  options: {
    nowMs?: number;
    queue: ConversationWorkQueue;
    state?: StateAdapter;
  },
): Promise<{ enqueued: number }> {
  const event = eventSchema.parse(input);
  const nowMs = options.nowMs ?? Date.now();
  const subscriptions = await findMatchingWatches({
    data: event.data,
    eventType: event.eventType,
    nowMs,
    namespace: event.namespace,
    identifier: event.identifier,
    state: options.state,
  });
  let enqueued = 0;
  const errors: unknown[] = [];
  const waitDeadlineMs = Date.now() + 10_000;
  for (const subscription of subscriptions) {
    try {
      const delivered = await deliverWatch({
        data: event.data,
        eventType: event.eventType,
        namespace: event.namespace,
        identifier: event.identifier,
        terminal: event.terminal,
        nowMs,
        state: options.state,
        subscription,
        waitDeadlineMs,
        deliver: async (current) => {
          const result = await enqueueEventNotification({
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
    throw new AggregateError(errors, "Failed to deliver one or more watches");
  }
  return { enqueued };
}
