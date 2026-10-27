import type { StateAdapter } from "chat";
import { eventSchema } from "@sentry/junior-plugin-api";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { logException } from "@/chat/logging";
import { enqueueEventNotification } from "@/chat/events/notification";
import { resolveEventPeopleMentions } from "@/chat/events/people";
import type { EventDoneBy } from "@/chat/task-input";
import { deliverWatch, findMatchingWatches } from "@/chat/events/store";

/** Match a normalized event and enqueue notifications into conversations. */
export async function ingestEvent(
  input: unknown,
  options: {
    nowMs?: number;
    queue: ConversationWorkQueue;
    /** Slack workspace whose users Event people resolve to. */
    slackTeamId?: string;
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
  // Resolve once per Event. Only matched Watches pay for the lookup.
  let people: string[] = [];
  let doneBy: EventDoneBy | undefined;
  const slackTeamId = options.slackTeamId;
  if (subscriptions.length > 0 && slackTeamId) {
    try {
      const [peopleMentions, [doneByMention]] = await Promise.all([
        resolveEventPeopleMentions(event.people ?? [], slackTeamId),
        resolveEventPeopleMentions(
          event.doneBy ? [event.doneBy] : [],
          slackTeamId,
        ),
      ]);
      people = peopleMentions;
      if (doneByMention && event.doneBy) {
        doneBy = {
          mention: doneByMention,
          ...("handle" in event.doneBy
            ? { handle: event.doneBy.handle }
            : undefined),
        };
      }
    } catch (error) {
      // People only add mentions. Deliver the Event without them.
      logException(error, "event.people.resolve.failed", {
        "app.event.event_type": event.eventType,
        "app.event.namespace": event.namespace,
      });
    }
  }
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
            doneBy,
            event,
            people,
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
