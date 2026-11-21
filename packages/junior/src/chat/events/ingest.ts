import type { StateAdapter } from "chat";
import { eventSchema } from "@sentry/junior-plugin-api";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { logException, logInfo } from "@/chat/logging";
import { resolveEventAuthor } from "@/chat/identities/trust";
import {
  addQuietEventNote,
  enqueueEventNotification,
} from "@/chat/events/notification";
import { resolveEventMentions } from "@/chat/events/people";
import {
  deliverWatch,
  findMatchingWatches,
  isQuietEvent,
  type Watch,
} from "@/chat/events/store";
import { slackMention } from "@/chat/slack/mrkdwn";

/** Match a normalized event and enqueue notifications into conversations. */
export async function ingestEvent(
  input: unknown,
  options: {
    /**
     * Last check before each delivery. A Watch that it denies, or that it
     * fails for, gets nothing.
     */
    admit?: (subscription: Watch) => Promise<boolean>;
    nowMs?: number;
    queue: ConversationWorkQueue;
    /** Slack workspace whose users Event people resolve to. */
    slackTeamId?: string | undefined;
    state?: StateAdapter | undefined;
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
  let people: string[] = [];
  if (options.slackTeamId && event.people?.length) {
    try {
      people = await resolveEventMentions(event.people, options.slackTeamId);
    } catch (error) {
      // People only add mentions. Deliver the Event without them.
      logException(error, "event.people.resolve.failed", {
        "app.event.event_type": event.eventType,
        "app.event.namespace": event.namespace,
      });
    }
  }
  // Only the trust decision names the author: it matched the immutable
  // account id. A handle match could point at whoever reused the login.
  const doneBy =
    author.status === "trusted" && author.actor
      ? { mention: slackMention(author.actor.userId), handle: author.handle }
      : undefined;
  // A Conversation whose Turn got this Event from another Watch needs no
  // note that says nobody was told. Watches that start a Turn go first, so
  // the set is complete before any Quiet Event. A duplicate means an earlier
  // delivery already gave the Turn this Event. A Watch that the
  // automated-turn limit pauses, or that fails, adds nothing.
  const turnConversations = new Set<string>();
  const ordered = [...subscriptions].sort(
    (left, right) =>
      Number(isQuietEvent(left, event.eventType)) -
      Number(isQuietEvent(right, event.eventType)),
  );
  let enqueued = 0;
  const errors: unknown[] = [];
  const waitDeadlineMs = Date.now() + 10_000;
  /* oxlint-disable no-await-in-loop -- Deliver to Watches in order; dispatch takes an index lock that does not wait. */
  for (const subscription of ordered) {
    // A Quiet Event is delivered, but it is not enqueued: it starts no Turn.
    let quiet = false;
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
          if (options.admit && !(await options.admit(current))) return false;
          if (isQuietEvent(current, event.eventType)) {
            quiet = true;
            if (!turnConversations.has(current.conversationId)) {
              await addQuietEventNote({ event, subscription: current });
            }
            return true;
          }
          const result = await enqueueEventNotification({
            author,
            doneBy,
            event,
            people,
            queue: options.queue,
            state: options.state,
            subscription: current,
          });
          if (result.status === "paused") return false;
          turnConversations.add(current.conversationId);
          return result.status === "appended";
        },
      });
      if (delivered && !quiet) {
        enqueued += 1;
      }
    } catch (error) {
      errors.push(error);
    }
  }
  /* oxlint-enable no-await-in-loop */
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to deliver one or more watches");
  }
  return { enqueued };
}
