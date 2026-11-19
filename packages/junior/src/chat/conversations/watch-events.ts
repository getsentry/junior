/**
 * Status Events of one Conversation, for Watches. A Watch on a Conversation
 * tells another Conversation, such as a Lead, when work there ends a Turn,
 * waits on a person, or stops. No Event is terminal: the Watch lasts until
 * it expires or is stopped, so it reports every Turn.
 *
 * The Events hold status only. The watcher reads the content with
 * `readConversationEvent`, which applies the access rule again.
 */
import type { Event, SubscribableResource } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import {
  CORE_EVENT_NAMESPACE,
  type EventRegistrationInput,
} from "@/chat/events/catalog";
import { ingestEvent } from "@/chat/events/ingest";
import { logException } from "@/chat/logging";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";

export const CONVERSATION_RESOURCE_TYPE = "conversation";
export const CONVERSATION_TURN_COMPLETED_EVENT = "conversation.turn.completed";
export const CONVERSATION_TURN_FAILED_EVENT = "conversation.turn.failed";
export const CONVERSATION_REVIEW_ITEM_OPENED_EVENT =
  "conversation.review_item.opened";
export const CONVERSATION_STOPPED_EVENT = "conversation.stopped";

const CONVERSATION_EVENTS = [
  CONVERSATION_TURN_COMPLETED_EVENT,
  CONVERSATION_TURN_FAILED_EVENT,
  CONVERSATION_REVIEW_ITEM_OPENED_EVENT,
  CONVERSATION_STOPPED_EVENT,
];

/** Core catalog entry for the status Events of a Conversation. */
export function conversationEvents(): EventRegistrationInput {
  const guidance =
    "Read the Conversation with readConversationEvent before you report it, and report only what the Watch intent asks for.";
  return {
    resourceTypes: [
      {
        type: CONVERSATION_RESOURCE_TYPE,
        supportedEvents: CONVERSATION_EVENTS,
        suggestedEvents: CONVERSATION_EVENTS,
      },
    ],
    events: Object.fromEntries(
      CONVERSATION_EVENTS.map((eventType) => [
        eventType,
        { reach: "resource", guidance },
      ]),
    ),
    limits: { [CONVERSATION_RESOURCE_TYPE]: { automation: false } },
  };
}

/** Describe the Watch that `startConversation` offers for a new Conversation. */
export function conversationWatch(input: {
  conversationId: string;
  title: string;
}): SubscribableResource {
  return {
    identifier: input.conversationId,
    label: `Conversation ${input.title}`,
    namespace: CORE_EVENT_NAMESPACE,
    supported_events: CONVERSATION_EVENTS,
    suggested_events: CONVERSATION_EVENTS,
    type: CONVERSATION_RESOURCE_TYPE,
  };
}

type ConversationStatus =
  | {
      type: "turn_completed";
      turnId: string;
      outcome: "success" | "no_reply" | "cancelled" | "blocked";
    }
  | { type: "turn_failed"; turnId: string; failureCode: string }
  | { type: "review_item_opened"; reviewItemId: string }
  | { type: "stopped"; stoppedAtMs: number };

function statusEvent(
  conversationId: string,
  status: ConversationStatus,
  occurredAtMs: number,
): Event {
  const base = {
    identifier: conversationId,
    namespace: CORE_EVENT_NAMESPACE,
    occurredAtMs,
    terminal: false,
  };
  const key = `${CORE_EVENT_NAMESPACE}:${CONVERSATION_RESOURCE_TYPE}:${conversationId}`;
  switch (status.type) {
    case "turn_completed":
      return {
        ...base,
        eventKey: `${key}:turn:${status.turnId}`,
        eventType: CONVERSATION_TURN_COMPLETED_EVENT,
        trustedSummary: `The Conversation ended a Turn: ${status.outcome}.`,
        data: { conversationId, outcome: status.outcome },
      };
    case "turn_failed":
      return {
        ...base,
        eventKey: `${key}:turn:${status.turnId}`,
        eventType: CONVERSATION_TURN_FAILED_EVENT,
        trustedSummary: `A Turn of the Conversation failed: ${status.failureCode}.`,
        data: { conversationId, failureCode: status.failureCode },
      };
    case "review_item_opened":
      return {
        ...base,
        eventKey: `${key}:review_item:${status.reviewItemId}`,
        eventType: CONVERSATION_REVIEW_ITEM_OPENED_EVENT,
        trustedSummary: "The Conversation waits on a person.",
        data: { conversationId, reviewItemId: status.reviewItemId },
      };
    case "stopped":
      return {
        ...base,
        eventKey: `${key}:stopped:${status.stoppedAtMs}`,
        eventType: CONVERSATION_STOPPED_EVENT,
        trustedSummary: "A person stopped the Conversation.",
        data: { conversationId },
      };
  }
}

/**
 * Deliver one status Event of a Conversation to the Watches on it. The work
 * that the Event reports already happened, so a failed delivery is logged
 * and never fails that work. A retry delivers the same Event key once.
 */
export async function publishConversationStatus(
  conversationId: string,
  status: ConversationStatus,
  options: {
    nowMs?: number;
    queue: ConversationWorkQueue;
    state?: StateAdapter | undefined;
  },
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const event = statusEvent(conversationId, status, nowMs);
  try {
    await ingestEvent(event, {
      nowMs,
      queue: options.queue,
      state: options.state,
    });
  } catch (error) {
    logException(error, "conversation.watch.publish.failed", {
      "app.conversation.id": conversationId,
      "app.event.event_type": event.eventType,
    });
  }
}
