import type { Event, EventData } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { getDb } from "@/chat/db";
import { ingestEventAutomations } from "@/chat/event-automations/ingest";
import {
  collectEventAutomationMatchKeys,
  findMatchingEventAutomations,
} from "@/chat/event-automations/store";
import { ingestEvent } from "@/chat/events/ingest";
import {
  collectEventMatchKeys,
  findMatchingWatches,
} from "@/chat/events/store";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { createEventTeamIdResolver } from "@/chat/events/workspace";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";

export type EventAppPublisher = {
  hasMatch(event: Event): Promise<boolean>;
  neededMatchKeys(input: {
    data?: EventData;
    eventTypes: string[];
    identifiers: string[];
    namespace: string;
  }): Promise<string[]>;
  publish(event: Event): Promise<void>;
};

/**
 * Check event automations for the `hasMatch` calls that start in one
 * synchronous run, such as a webhook checking each copy of its Event with
 * `Promise.all`, with one read per namespace. A batch takes calls until its
 * read starts and keeps nothing after it, so each answer is the same as from
 * a read for that Event alone.
 */
function createEventAutomationMatcher(
  resolveTeamId: () => Promise<string | undefined>,
): (event: Event) => Promise<boolean> {
  const batches = new Map<
    string,
    { events: Event[]; matches: Promise<boolean[]> }
  >();
  return async (event) => {
    let batch = batches.get(event.namespace);
    if (!batch) {
      const events: Event[] = [];
      const matches = Promise.resolve().then(async () => {
        batches.delete(event.namespace);
        const teamId = await resolveTeamId();
        if (!teamId) return events.map(() => false);
        const tasks = await findMatchingEventAutomations(
          getDb(),
          events,
          teamId,
          getEventCatalog(),
        );
        return tasks.map((matched) => matched.length > 0);
      });
      batch = { events, matches };
      batches.set(event.namespace, batch);
    }
    const index = batch.events.push(event) - 1;
    return (await batch.matches)[index] === true;
  };
}

/** Build the core event publisher used by plugin routes. */
export function createEventAppPublisher(args: {
  conversationWork: () => {
    queue?: ConversationWorkQueue;
    state?: StateAdapter;
  };
}): EventAppPublisher {
  // Event automations still key by destination team until that store is conversation-owned.
  const resolveEventAutomationTeamId = createEventTeamIdResolver();
  const hasEventAutomationMatch = createEventAutomationMatcher(
    resolveEventAutomationTeamId,
  );

  return {
    async hasMatch(event) {
      const work = args.conversationWork();
      const [subscriptions, taskMatch] = await Promise.all([
        findMatchingWatches({
          data: event.data,
          eventType: event.eventType,
          namespace: event.namespace,
          identifier: event.identifier,
          state: work.state,
        }),
        hasEventAutomationMatch(event),
      ]);
      return subscriptions.length > 0 || taskMatch;
    },
    async neededMatchKeys(input) {
      const work = args.conversationWork();
      const eventAutomationTeamId = await resolveEventAutomationTeamId();
      const [watchKeys, taskKeys] = await Promise.all([
        collectEventMatchKeys({
          eventTypes: input.eventTypes,
          identifiers: input.identifiers,
          namespace: input.namespace,
          state: work.state,
        }),
        eventAutomationTeamId
          ? collectEventAutomationMatchKeys(getDb(), {
              catalog: getEventCatalog(),
              ...(input.data ? { data: input.data } : undefined),
              eventTypes: input.eventTypes,
              identifiers: input.identifiers,
              namespace: input.namespace,
              teamId: eventAutomationTeamId,
            })
          : Promise.resolve([] as string[]),
      ]);
      return [...new Set([...watchKeys, ...taskKeys])].sort();
    },
    async publish(event) {
      const work = args.conversationWork();
      const queue = work.queue ?? getVercelConversationWorkQueue();
      const eventAutomationTeamId = await resolveEventAutomationTeamId();
      await Promise.all([
        ingestEvent(event, {
          queue,
          // Junior runs one Slack bot, so every Watch is in this workspace.
          slackTeamId: eventAutomationTeamId,
          state: work.state,
        }),
        eventAutomationTeamId
          ? ingestEventAutomations(event, {
              queue,
              teamId: eventAutomationTeamId,
            })
          : Promise.resolve(),
      ]);
    },
  };
}
