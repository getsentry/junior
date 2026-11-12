import type { Event, EventData } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import pLimit from "p-limit";
import { getDb } from "@/chat/db";
import { ingestEventAutomations } from "@/chat/event-automations/ingest";
import {
  collectEventAutomationMatchKeys,
  findMatchingEventAutomations,
} from "@/chat/event-automations/store";
import { eventAuthorTrustOnce } from "@/chat/events/author";
import { ingestEvent } from "@/chat/events/ingest";
import {
  collectEventMatchKeys,
  findMatchingWatches,
} from "@/chat/events/store";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { createEventTeamIdResolver } from "@/chat/events/workspace";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";

// Each Watch check reads the state adapter. Bound the reads for a webhook
// with many events.
const WATCH_MATCH_CONCURRENCY = 4;

export type EventAppPublisher = {
  hasMatch(events: Event[]): Promise<boolean>;
  neededMatchKeys(input: {
    data?: EventData;
    eventTypes: string[];
    identifiers: string[];
    namespace: string;
  }): Promise<string[]>;
  publish(event: Event): Promise<void>;
};

/** Build the core event publisher used by plugin routes. */
export function createEventAppPublisher(args: {
  /**
   * Allowed Slack email domains, read when an Event is published. They
   * decide which Event authors are trusted.
   */
  allowedDomains: () => readonly string[];
  conversationWork: () => {
    queue?: ConversationWorkQueue;
    state?: StateAdapter;
  };
}): EventAppPublisher {
  // Event automations still key by destination team until that store is conversation-owned.
  const resolveEventAutomationTeamId = createEventTeamIdResolver();

  return {
    async hasMatch(events) {
      const work = args.conversationWork();
      const eventAutomationTeamId = await resolveEventAutomationTeamId();
      const limit = pLimit(WATCH_MATCH_CONCURRENCY);
      const [subscriptions, tasks] = await Promise.all([
        Promise.all(
          events.map((event) =>
            limit(() =>
              findMatchingWatches({
                data: event.data,
                eventType: event.eventType,
                namespace: event.namespace,
                identifier: event.identifier,
                state: work.state,
              }),
            ),
          ),
        ),
        eventAutomationTeamId
          ? findMatchingEventAutomations(
              getDb(),
              events,
              eventAutomationTeamId,
              getEventCatalog(),
            )
          : Promise.resolve([]),
      ]);
      return [...subscriptions, ...tasks].some((matched) => matched.length > 0);
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
      // Watches and Event automations share one trust decision. Core drops an
      // Event from an untrusted author before either path starts a Turn.
      const authorTrust = eventAuthorTrustOnce(event, {
        allowedDomains: args.allowedDomains(),
        slackTeamId: eventAutomationTeamId,
      });
      await Promise.all([
        ingestEvent(event, {
          authorTrust,
          queue,
          // Junior runs one Slack bot, so every Watch is in this workspace.
          slackTeamId: eventAutomationTeamId,
          state: work.state,
        }),
        eventAutomationTeamId
          ? ingestEventAutomations(event, {
              authorTrust,
              queue,
              teamId: eventAutomationTeamId,
            })
          : Promise.resolve(),
      ]);
    },
  };
}
