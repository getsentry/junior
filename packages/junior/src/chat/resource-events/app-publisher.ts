import type { ResourceEvent } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { getDb } from "@/chat/db";
import { ingestEventTasks } from "@/chat/event-tasks/ingest";
import { collectEventTaskMatchKeys } from "@/chat/event-tasks/store";
import { logWarn } from "@/chat/logging";
import { ingestResourceEvent } from "@/chat/resource-events/ingest";
import { collectResourceEventMatchKeys } from "@/chat/resource-events/store";
import {
  createResourceEventInstallResolver,
  createResourceEventTeamIdResolver,
} from "@/chat/resource-events/workspace";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";

export type ResourceEventAppPublisher = {
  neededMatchKeys(input: {
    eventTypes: string[];
    identifiers: string[];
    namespace: string;
  }): Promise<string[]>;
  publish(event: ResourceEvent): Promise<void>;
};

/** Build the core resource-event publisher used by plugin routes. */
export function createResourceEventAppPublisher(args: {
  conversationWork: () => {
    queue?: ConversationWorkQueue;
    state?: StateAdapter;
  };
}): ResourceEventAppPublisher {
  const resolveInstall = createResourceEventInstallResolver();
  // Event tasks still key by destination team until that store is conversation-owned.
  const resolveEventTaskTeamId = createResourceEventTeamIdResolver();

  return {
    async neededMatchKeys(input) {
      if (!(await resolveInstall())) return [];
      const work = args.conversationWork();
      const eventTaskTeamId = await resolveEventTaskTeamId();
      const [watchKeys, taskKeys] = await Promise.all([
        collectResourceEventMatchKeys({
          eventTypes: input.eventTypes,
          identifiers: input.identifiers,
          namespace: input.namespace,
          state: work.state,
        }),
        eventTaskTeamId
          ? collectEventTaskMatchKeys(getDb(), {
              eventTypes: input.eventTypes,
              identifiers: input.identifiers,
              namespace: input.namespace,
              teamId: eventTaskTeamId,
            })
          : Promise.resolve([] as string[]),
      ]);
      return [...new Set([...watchKeys, ...taskKeys])].sort();
    },
    async publish(event) {
      if (!(await resolveInstall())) {
        logWarn("resource_event.delivery.unavailable", {
          "app.resource_event.namespace": event.namespace,
          "app.resource_event.reason": "install_not_ready",
        });
        return;
      }
      const work = args.conversationWork();
      const queue = work.queue ?? getVercelConversationWorkQueue();
      const eventTaskTeamId = await resolveEventTaskTeamId();
      await Promise.all([
        ingestResourceEvent(event, {
          queue,
          state: work.state,
        }),
        eventTaskTeamId
          ? ingestEventTasks(event, {
              queue,
              teamId: eventTaskTeamId,
            })
          : Promise.resolve(),
      ]);
    },
  };
}
