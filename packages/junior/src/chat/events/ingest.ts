import type { StateAdapter } from "chat";
import { eventSchema } from "@sentry/junior-plugin-api";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { logException, logInfo } from "@/chat/logging";
import { resolveEventAuthor } from "@/chat/identities/trust";
import { enqueueEventNotification } from "@/chat/events/notification";
import { resolveEventMentions, type EventMentions } from "@/chat/events/people";
import { deliverWatch, findMatchingWatches } from "@/chat/events/store";
import { slackMention } from "@/chat/slack/mrkdwn";

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
  if (subscriptions.length === 0) return { enqueued: 0 };
  // Only matched Watches pay for the lookups.
  const author = await resolveEventAuthor(event);
  if (author.status === "untrusted") {
    logInfo("event.author.untrusted", {
      "app.event.event_type": event.eventType,
      "app.event.namespace": event.namespace,
      "app.event.author.reason": author.reason,
    });
  }
  let mentions: EventMentions = { people: [] };
  if (options.slackTeamId) {
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
  // The trust decision matched the immutable account id, so its Slack member
  // names the author better than a handle match.
  const doneBy =
    author.status === "trusted" && author.actor
      ? { mention: slackMention(author.actor.userId), handle: author.handle }
      : mentions.doneBy;
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
            author,
            doneBy,
            event,
            people: mentions.people,
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
