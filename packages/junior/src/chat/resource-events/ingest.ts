import type { StateAdapter } from "chat";
import { z } from "zod";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { enqueueResourceEventNotification } from "@/chat/resource-events/notification";
import {
  deliverResourceEventSubscription,
  findMatchingResourceEventSubscriptions,
} from "@/chat/resource-events/store";

const ingestResourceEventInputSchema = z
  .object({
    eventKey: z.string().min(1),
    eventType: z.string().min(1),
    occurredAtMs: z.number().finite(),
    provider: z.string().min(1),
    resourceRef: z.string().min(1),
    terminal: z.boolean().optional(),
    trustedSummary: z.string().min(1),
    untrustedText: z.string().optional(),
  })
  .strict();

export type IngestResourceEventInput = z.output<
  typeof ingestResourceEventInputSchema
>;

/** Match a normalized provider event and enqueue notifications into conversations. */
export async function ingestResourceEvent(
  input: unknown,
  options: {
    nowMs?: number;
    queue: ConversationWorkQueue;
    state?: StateAdapter;
  },
): Promise<{ enqueued: number }> {
  const event = ingestResourceEventInputSchema.parse(input);
  const nowMs = options.nowMs ?? Date.now();
  const subscriptions = await findMatchingResourceEventSubscriptions({
    eventType: event.eventType,
    nowMs,
    provider: event.provider,
    resourceRef: event.resourceRef,
    state: options.state,
  });
  let enqueued = 0;
  const errors: unknown[] = [];
  const waitDeadlineMs = Date.now() + 10_000;
  for (const subscription of subscriptions) {
    try {
      const delivered = await deliverResourceEventSubscription({
        eventType: event.eventType,
        provider: event.provider,
        resourceRef: event.resourceRef,
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
