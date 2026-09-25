import type { Event } from "@sentry/junior-plugin-api";
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
import { createEventTeamIdResolver } from "@/chat/events/workspace";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";

export type EventAppPublisher = {
  hasMatch(event: Event): Promise<boolean>;
  neededMatchKeys(input: {
    eventTypes: string[];
    identifiers: string[];
    namespace: string;
  }): Promise<string[]>;
  publish(event: Event): Promise<void>;
};

/** Build the core event publisher used by plugin routes. */
export function createEventAppPublisher(args: {
  conversationWork: () => {
    queue?: ConversationWorkQueue;
    state?: StateAdapter;
  };
}): EventAppPublisher {
  // Event automations still key by destination team until that store is conversation-owned.
  const resolveEventAutomationTeamId = createEventTeamIdResolver();

  return {
    async hasMatch(event) {
      const work = args.conversationWork();
      const eventAutomationTeamId = await resolveEventAutomationTeamId();
      const [subscriptions, tasks] = await Promise.all([
        findMatchingWatches({
          data: event.data,
          eventType: event.eventType,
          namespace: event.namespace,
          identifier: event.identifier,
          state: work.state,
        }),
        eventAutomationTeamId
          ? findMatchingEventAutomations(getDb(), event, eventAutomationTeamId)
          : Promise.resolve([]),
      ]);
      return subscriptions.length > 0 || tasks.length > 0;
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
