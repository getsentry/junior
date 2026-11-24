/**
 * Agent updates of one Conversation, for Watches. A Watch on a Conversation
 * gets the same agent update that a parent gets from a child agent, in the
 * same `<agent-result>` format, when work there ends a Turn, waits on a
 * person, or stops. Every kind of Conversation sends it. No update is
 * terminal: the Watch lasts until it expires or is stopped, so it reports
 * every Turn.
 *
 * Only a Conversation that may read the target watches it, under
 * `policies/conversation-access.md`. Delivery checks again and fails closed
 * before any text from the target reaches the watcher, because visibility
 * can change.
 */
import type { SubscribableResource } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { AGENT_UPDATE_EVENT_TYPE } from "@/chat/agent-invocations/result-event-type";
import type { AgentUpdate } from "@/chat/agent-invocations/agent-update";
import {
  CORE_EVENT_NAMESPACE,
  type EventRegistrationInput,
} from "@/chat/events/catalog";
import { findMatchingWatches, type Watch } from "@/chat/events/store";
import { logException } from "@/chat/logging";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";

export const CONVERSATION_RESOURCE_TYPE = "conversation";

const CONVERSATION_EVENTS = [AGENT_UPDATE_EVENT_TYPE];

// TODO(dcramer): Remove 30 days after agent updates ship, when every Watch
// made before them has expired. Those Watches name these Event types.
const LEGACY_EVENT_TYPES: Record<UpdateKey["type"], string> = {
  stopped: "conversation.stopped",
  turn: "conversation.completed",
  turn_failed: "conversation.failed",
  waiting: "conversation.waiting",
};

/** Core catalog entry for the agent updates of a Conversation. */
export function conversationEvents(): EventRegistrationInput {
  return {
    resourceTypes: [
      {
        type: CONVERSATION_RESOURCE_TYPE,
        supportedEvents: CONVERSATION_EVENTS,
        suggestedEvents: CONVERSATION_EVENTS,
      },
    ],
    events: {
      [AGENT_UPDATE_EVENT_TYPE]: {
        reach: "resource",
        guidance:
          "Report only what the Watch intent asks for. Read the Conversation with readConversationEvent only when the update does not say enough.",
      },
    },
    limits: { [CONVERSATION_RESOURCE_TYPE]: { automation: false } },
  };
}

/** Describe the Watch that a Lead's `startAgent` offers for a new root. */
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

/** What one update reports. Its Event key delivers it once. */
type UpdateKey =
  | { type: "turn"; turnId: string }
  | { type: "turn_failed"; turnId: string }
  | { type: "waiting"; inboxItemId: string }
  | { type: "stopped"; stoppedAtMs: number };

function updateEventKey(conversationId: string, key: UpdateKey): string {
  const prefix = `${CORE_EVENT_NAMESPACE}:${CONVERSATION_RESOURCE_TYPE}:${conversationId}`;
  switch (key.type) {
    case "turn":
    case "turn_failed":
      return `${prefix}:turn:${key.turnId}`;
    case "waiting":
      return `${prefix}:inbox_item:${key.inboxItemId}`;
    case "stopped":
      return `${prefix}:stopped:${key.stoppedAtMs}`;
  }
}

/** One Watch that matched an update, with the Event type it names. */
export type MatchedWatch = { eventType: string; watch: Watch };

async function findUpdateWatches(
  conversationId: string,
  key: UpdateKey,
  nowMs: number,
  state: StateAdapter | undefined,
): Promise<MatchedWatch[]> {
  const matched = new Map<string, MatchedWatch>();
  for (const eventType of [
    AGENT_UPDATE_EVENT_TYPE,
    LEGACY_EVENT_TYPES[key.type],
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Two index reads; the legacy one goes away with LEGACY_EVENT_TYPES.
    for (const watch of await findMatchingWatches({
      eventType,
      identifier: conversationId,
      namespace: CORE_EVENT_NAMESPACE,
      nowMs,
      state,
    })) {
      if (!matched.has(watch.id)) matched.set(watch.id, { eventType, watch });
    }
  }
  return [...matched.values()];
}

/**
 * Deliver one agent update of a Conversation to the Watches that may still
 * read it. `skip` and `update` run only when a Watch matches, so a
 * Conversation that no one watches pays only the Watch index reads. An
 * undefined update reports nothing. The work that the update reports already
 * happened, so a failed delivery is logged and never fails that work. A
 * retry delivers the same Event key once.
 */
export async function publishAgentUpdate(
  conversationId: string,
  key: UpdateKey,
  options: {
    nowMs?: number;
    queue: ConversationWorkQueue;
    skip?: () => Promise<boolean>;
    state?: StateAdapter | undefined;
    update: () => Promise<AgentUpdate | undefined>;
  },
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  try {
    const watches = await findUpdateWatches(
      conversationId,
      key,
      nowMs,
      options.state,
    );
    if (watches.length === 0 || (await options.skip?.())) return;
    const update = await options.update();
    if (!update) return;
    // Loaded on use: delivery reaches the Conversation mailbox, which
    // imports this module, and its graph is too large for every Inbox item
    // writer.
    const { deliverAgentUpdate } = await import("./agent-update-delivery");
    await deliverAgentUpdate({
      conversationId,
      eventKey: updateEventKey(conversationId, key),
      nowMs,
      queue: options.queue,
      state: options.state,
      update,
      watches,
    });
  } catch (error) {
    logException(error, "conversation.watch.publish.failed", {
      "app.conversation.id": conversationId,
      "app.event.event_type": AGENT_UPDATE_EVENT_TYPE,
    });
  }
}
