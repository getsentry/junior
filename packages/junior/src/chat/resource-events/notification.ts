import { botConfig } from "@/chat/config";
import { logInfo } from "@/chat/logging";
import { admitAutomatedTurn } from "@/chat/services/automated-turn-limit";
import { postAutomatedTurnLimitNoticeForConversation } from "@/chat/slack/automated-turn-limit-notice";
import { renderTaskInput } from "@/chat/task-input";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  appendAndEnqueueInboundMessage,
  type AppendAndEnqueueInboundMessageResult,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type { ResourceEventSubscription } from "@/chat/resource-events/store";
import { resourceEventGuidance } from "@/chat/resource-events/catalog";
import { getResourceEventCatalog } from "@/chat/resource-events/runtime-catalog";
import { RESOURCE_EVENT_AUTHOR_ID } from "@/chat/resource-events/actor";

export interface ResourceEventNotification {
  eventKey: string;
  eventType: string;
  occurredAtMs: number;
  namespace: string;
  identifier: string;
  terminal?: boolean;
  trustedSummary: string;
  data?: Record<string, unknown>;
  untrustedText?: string;
}

/**
 * Render the runtime-owned conversation message for a subscribed event.
 *
 * Keep this short: facts the model cannot reconstruct, plus a one-line handling
 * contract. Stable delivery rules live in runtime and docs, not this prompt.
 */
export function renderResourceEventNotificationText(
  subscription: Pick<
    ResourceEventSubscription,
    "intent" | "label" | "resourceType"
  >,
  event: Pick<
    ResourceEventNotification,
    "namespace" | "eventType" | "trustedSummary" | "data" | "untrustedText"
  >,
): string {
  const guidance = resourceEventGuidance(
    getResourceEventCatalog(),
    event.namespace,
    subscription.resourceType,
    event.eventType,
  );
  return renderTaskInput({
    about: subscription.label,
    instructions: subscription.intent,
    guidance,
    trustedSummary: event.trustedSummary,
    verifiedDetails: event.data,
    externalText: event.untrustedText,
  });
}

/** Resource-event metadata stored on plain mailbox input. */
export type ResourceEventMailboxMetadata = {
  kind: "resource_event";
  resourceEvent: {
    eventKey: string;
    eventType: string;
    namespace: string;
    identifier: string;
    subscriptionId: string;
  };
} & Record<string, unknown>;

/** Whether mailbox metadata is a plain resource-event wake. */
export function isResourceEventMailboxMetadata(
  value: unknown,
): value is ResourceEventMailboxMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "resource_event") {
    return false;
  }
  const resourceEvent = record.resourceEvent;
  if (
    !resourceEvent ||
    typeof resourceEvent !== "object" ||
    Array.isArray(resourceEvent)
  ) {
    return false;
  }
  const fields = resourceEvent as Record<string, unknown>;
  return (
    typeof fields.eventKey === "string" &&
    typeof fields.eventType === "string" &&
    typeof fields.namespace === "string" &&
    typeof fields.identifier === "string" &&
    typeof fields.subscriptionId === "string"
  );
}

/** Build plain conversation mailbox input for one matched watch. */
export function createResourceEventInboundMessage(input: {
  event: ResourceEventNotification;
  subscription: Pick<ResourceEventSubscription, "conversationId" | "id">;
  text: string;
  receivedAtMs?: number;
}): InboundMessage {
  const metadata: ResourceEventMailboxMetadata = {
    kind: "resource_event",
    resourceEvent: {
      eventKey: input.event.eventKey,
      eventType: input.event.eventType,
      namespace: input.event.namespace,
      identifier: input.event.identifier,
      subscriptionId: input.subscription.id,
    },
  };
  return {
    conversationId: input.subscription.conversationId,
    createdAtMs: input.event.occurredAtMs,
    inboundMessageId: `resource-event:${input.subscription.id}:${input.event.eventKey}`,
    delivery: "defer",
    source: "resource_event",
    receivedAtMs: input.receivedAtMs ?? Date.now(),
    input: {
      text: input.text,
      authorId: RESOURCE_EVENT_AUTHOR_ID,
      metadata,
    },
  };
}

/**
 * Enqueue a resource event as normal conversation mailbox input.
 *
 * The watch only names the conversation. Destination stays on the conversation
 * and is applied when the worker runs. After too many automated Turns with no
 * user Turn, later wakes stay quiet until a user message clears the pause.
 */
export async function enqueueResourceEventNotification(args: {
  event: ResourceEventNotification;
  queue: ConversationWorkQueue;
  subscription: ResourceEventSubscription;
  state?: Parameters<typeof appendAndEnqueueInboundMessage>[0]["state"];
}): Promise<AppendAndEnqueueInboundMessageResult> {
  const maxTurns = botConfig.maxConsecutiveAutomatedTurns;
  const decision = await admitAutomatedTurn({
    conversationId: args.subscription.conversationId,
    maxTurns,
    nowMs: args.event.occurredAtMs,
    state: args.state,
  });
  if (decision.status === "paused") {
    logInfo("resource_events.automated_turn_limit.paused", {
      conversationId: args.subscription.conversationId,
      "app.automated_turn_limit.consecutive": decision.consecutiveAutomatedTurns,
      "app.automated_turn_limit.max": maxTurns,
      "app.resource_event.event_type": args.event.eventType,
      "app.resource_event.namespace": args.event.namespace,
    });
    if (decision.shouldPostNotice) {
      // Safety net when the Turn that hit the limit could not post a notice.
      await postAutomatedTurnLimitNoticeForConversation({
        conversationId: args.subscription.conversationId,
        maxTurns,
        nowMs: args.event.occurredAtMs,
      });
    }
    // Do not enqueue a Turn. Terminal watches may still complete after this.
    return { status: "duplicate" };
  }

  const text = renderResourceEventNotificationText(
    args.subscription,
    args.event,
  );
  return await appendAndEnqueueInboundMessage({
    message: createResourceEventInboundMessage({
      event: args.event,
      subscription: {
        conversationId: args.subscription.conversationId,
        id: args.subscription.id,
      },
      text,
    }),
    queue: args.queue,
    state: args.state,
  });
}
