import type { StateAdapter } from "chat";
import { eventSchema } from "@sentry/junior-plugin-api";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { logException } from "@/chat/logging";
import { enqueueEventNotification } from "@/chat/events/notification";
import { resolveEventMentions, type EventMentions } from "@/chat/events/people";
import {
  requesterInstructionFor,
  resolveEventDoerSlackUserId,
} from "@/chat/events/requester";
import { deliverWatch, findMatchingWatches } from "@/chat/events/store";

/** Match a normalized event and enqueue notifications into conversations. */
export async function ingestEvent(
  input: unknown,
  options: {
    /**
     * Allowed Slack email domains. Without them, core treats no Event text
     * as a requester instruction.
     */
    allowedDomains?: readonly string[];
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
  let mentions: EventMentions = { people: [] };
  if (subscriptions.length > 0 && options.slackTeamId) {
    try {
      mentions = await resolveEventMentions(event, options.slackTeamId);
    } catch (error) {
      // People only add mentions. Deliver the Event without them.
      logException(error, "event.people.resolve.failed", {
        "app.event.event_type": event.eventType,
        "app.event.namespace": event.namespace,
      });
    }
  }
  // Only a Watch with a requester can receive a requester instruction.
  let doerSlackUserId: string | undefined;
  if (
    options.allowedDomains &&
    options.slackTeamId &&
    subscriptions.some((subscription) => subscription.requester)
  ) {
    try {
      doerSlackUserId = await resolveEventDoerSlackUserId(event, {
        allowedDomains: options.allowedDomains,
        slackTeamId: options.slackTeamId,
      });
    } catch (error) {
      // Deliver the Event. Its text then stays untrusted, as for an unlinked
      // doer.
      logException(error, "event.doer.resolve.failed", {
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
            doneBy: mentions.doneBy,
            event,
            people: mentions.people,
            queue: options.queue,
            requesterInstruction: requesterInstructionFor({
              doerSlackUserId,
              event,
              slackTeamId: options.slackTeamId,
              subscription: current,
            }),
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
