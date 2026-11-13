import {
  defineConversationEvent,
  type ConversationEventPresentation,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { getConversationEventStore } from "@/chat/db";
import type { ConversationBriefVersion } from "./store";

/** Stored namespace of Brief events. It predates core Briefs; keep it stable. */
export const BRIEF_EVENT_NAMESPACE = "briefs";

/** Stored name of the event that records one Brief version and its cost. */
export const BRIEF_UPDATED_EVENT = "brief_updated";

function renderBriefUpdated(event: { version: number }) {
  return {
    icon: "activity" as const,
    title: `Brief updated (v${event.version})`,
  };
}

/** Previous stored Brief event shape retained for transcript rendering. */
const briefUpdatedEventV1 = defineConversationEvent({
  name: BRIEF_UPDATED_EVENT,
  version: 1,
  schema: z
    .object({
      version: z.number().int().positive(),
      modelId: z.string().min(1),
      costUsd: z.number().finite().nonnegative().optional(),
      decisions: z.number().int().nonnegative(),
      openDecisions: z.number().int().nonnegative(),
      links: z.number().int().nonnegative(),
    })
    .strict(),
  renderEvent: renderBriefUpdated,
});

/** Durable cost and size record for one stored Brief version. */
const briefUpdatedEvent = defineConversationEvent({
  name: BRIEF_UPDATED_EVENT,
  version: 2,
  schema: z
    .object({
      version: z.number().int().positive(),
      modelId: z.string().min(1),
      costUsd: z.number().finite().nonnegative().optional(),
      decisions: z.number().int().nonnegative(),
      links: z.number().int().nonnegative(),
    })
    .strict(),
  renderEvent: renderBriefUpdated,
});

const BRIEF_EVENT_DEFINITIONS = [briefUpdatedEventV1, briefUpdatedEvent];

/**
 * Append the `brief_updated` event for one stored Brief. The key uses the
 * stable task operation id and the first event version, so a retry or a newer
 * schema adds no second event.
 */
export async function appendBriefUpdatedEvent(args: {
  operationId: string;
  stored: ConversationBriefVersion;
}): Promise<void> {
  const { stored } = args;
  await getConversationEventStore().append(
    stored.conversationId,
    [
      {
        createdAtMs: Date.now(),
        idempotencyKey:
          `plugin:${BRIEF_EVENT_NAMESPACE}:operation:${args.operationId}:` +
          `event:${briefUpdatedEvent.eventName}@${briefUpdatedEventV1.version}`,
        data: {
          type: "structured_event",
          namespace: BRIEF_EVENT_NAMESPACE,
          name: briefUpdatedEvent.eventName,
          version: briefUpdatedEvent.version,
          turnId: stored.turnId,
          content: briefUpdatedEvent.parse({
            version: stored.version,
            modelId: stored.modelId,
            ...(stored.costUsd !== undefined
              ? { costUsd: stored.costUsd }
              : undefined),
            decisions: stored.content.decisions.length,
            links: stored.content.links.length,
          }),
        },
      },
    ],
    { activity: "preserve" },
  );
}

/** Render one stored Brief event, or nothing for an unknown version. */
export function renderBriefConversationEvent(args: {
  content: Record<string, unknown>;
  name: string;
  version: number;
}): ConversationEventPresentation | undefined {
  const definition = BRIEF_EVENT_DEFINITIONS.find(
    (candidate) =>
      candidate.eventName === args.name && candidate.version === args.version,
  );
  if (!definition) return undefined;
  return definition.renderEvent(definition.parse(args.content));
}
