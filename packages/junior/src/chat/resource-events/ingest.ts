import type { StateAdapter } from "chat";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { enqueueResourceEventNotification } from "@/chat/resource-events/notification";
import type { ResourceEventNotification } from "@/chat/resource-events/notification";
import {
  completeResourceEventSubscription,
  findMatchingResourceEventSubscriptions,
} from "@/chat/resource-events/store";

export interface IngestResourceEventInput extends ResourceEventNotification {}

/** Match a normalized provider event and enqueue notifications into conversations. */
export async function ingestResourceEvent(
  input: IngestResourceEventInput,
  options: {
    nowMs?: number;
    queue: ConversationWorkQueue;
    state?: StateAdapter;
  },
): Promise<{ enqueued: number }> {
  const nowMs = options.nowMs ?? Date.now();
  const subscriptions = await findMatchingResourceEventSubscriptions({
    eventType: input.eventType,
    nowMs,
    provider: input.provider,
    resourceRef: input.resourceRef,
    state: options.state,
  });
  let enqueued = 0;
  for (const subscription of subscriptions) {
    await enqueueResourceEventNotification({
      event: input,
      queue: options.queue,
      state: options.state,
      subscription,
    });
    enqueued += 1;
    if (input.terminal) {
      await completeResourceEventSubscription({
        id: subscription.id,
        nowMs,
        state: options.state,
      });
    }
  }
  return { enqueued };
}
