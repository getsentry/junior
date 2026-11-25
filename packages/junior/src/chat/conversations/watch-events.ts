/**
 * Agent updates of one Conversation, for its Watches and its starter. When
 * work there ends a Turn, waits on a person, or stops, every kind of
 * Conversation sends one update. A Watch on it and the agent that started
 * it get that update, in the same `<agent-result>` format, from the same
 * code. No update is terminal: a Watch lasts until it expires or is
 * stopped, so it reports every Turn.
 *
 * The starter's Watch is the stored parent edge of a child agent. It never
 * expires, and no stop cancels it. Only a Conversation that may read the
 * target makes another Watch on it, under `policies/conversation-access.md`.
 * Delivery checks again and fails closed before any text from the target
 * reaches that watcher, because visibility can change.
 */
import type { Actor, SubscribableResource } from "@sentry/junior-plugin-api";
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

export const AGENT_RESOURCE_TYPE = "agent";

// The resource type of these Watches before `agent`. Watches made before
// the rename still name it.
const LEGACY_AGENT_RESOURCE_TYPE = "conversation";

/** True when a Watch's resource type names an agent, also by its old name. */
export function isAgentResourceType(resourceType: string): boolean {
  return (
    resourceType === AGENT_RESOURCE_TYPE ||
    resourceType === LEGACY_AGENT_RESOURCE_TYPE
  );
}

const AGENT_EVENTS = [AGENT_UPDATE_EVENT_TYPE];

/**
 * The id of the Watch that a child agent's parent edge makes for its
 * starter. No Watch record holds it, so no tool stops it.
 */
export function starterWatchId(childConversationId: string): string {
  return `starter:${childConversationId}`;
}

// TODO(dcramer): Remove 30 days after agent updates ship, when every Watch
// made before them has expired. Those Watches name these Event types.
const LEGACY_EVENT_TYPES: Record<UpdateKey["type"], string> = {
  stopped: "conversation.stopped",
  turn: "conversation.completed",
  turn_failed: "conversation.failed",
  waiting: "conversation.waiting",
};

/** Core catalog entry for the agent updates of a Conversation. */
export function agentEvents(): EventRegistrationInput {
  return {
    resourceTypes: [
      {
        type: AGENT_RESOURCE_TYPE,
        supportedEvents: AGENT_EVENTS,
        suggestedEvents: AGENT_EVENTS,
      },
    ],
    events: {
      [AGENT_UPDATE_EVENT_TYPE]: {
        reach: "resource",
        guidance:
          "Report only what the Watch intent asks for. Read the Conversation with readConversationEvent only when the update does not say enough.",
      },
    },
    limits: { [AGENT_RESOURCE_TYPE]: { automation: false } },
  };
}

/** Describe the Watch that `startConversation` offers for a new Conversation. */
export function agentWatch(input: {
  conversationId: string;
  title: string;
}): SubscribableResource {
  return {
    identifier: input.conversationId,
    label: `Conversation ${input.title}`,
    namespace: CORE_EVENT_NAMESPACE,
    supported_events: AGENT_EVENTS,
    suggested_events: AGENT_EVENTS,
    type: AGENT_RESOURCE_TYPE,
  };
}

/** What one update reports. Its Event key delivers it once. */
export type UpdateKey =
  | { type: "turn"; turnId: string }
  | { type: "turn_failed"; turnId: string }
  | { type: "waiting"; inboxItemId: string }
  | { type: "stopped"; stoppedAtMs: number };

function updateEventKey(conversationId: string, key: UpdateKey): string {
  // The key keeps the legacy resource type, so a retry across the rename
  // still delivers the update once.
  const prefix = `${CORE_EVENT_NAMESPACE}:${LEGACY_AGENT_RESOURCE_TYPE}:${conversationId}`;
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
 * Deliver one agent update of a Conversation to its starter and to the
 * Watches that may still read it. `skip` and `update` run only when someone
 * gets the update, so a root that no one watches pays only the reads that
 * find nobody. An undefined update reports nothing. A Watch skips the
 * update when `skip` says so. The work that the update reports already
 * happened, so a failed Watch delivery is logged and never fails that work.
 * A failed delivery to the starter throws, so that work retries it: the
 * starter must hear from its child. A retry delivers the same Event key
 * once.
 */
export async function publishAgentUpdate(
  conversationId: string,
  key: UpdateKey,
  options: {
    nowMs?: number;
    queue: ConversationWorkQueue;
    skip?: () => Promise<boolean>;
    /**
     * The Actor that the starter's Turn for this update runs as, by default
     * the Event system Actor. `false` leaves the starter out, as for a stop
     * of a tree: whoever stopped it already knows.
     */
    starter?: Actor | false;
    state?: StateAdapter | undefined;
    update: () => Promise<AgentUpdate | undefined>;
  },
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const eventKey = updateEventKey(conversationId, key);
  let update: Promise<AgentUpdate | undefined> | undefined;
  const readUpdate = () => (update ??= options.update());
  // Loaded on use: delivery reaches the Conversation mailbox, which imports
  // this module, and its graph is too large for every Inbox item writer.
  const delivery = () => import("./agent-update-delivery");
  if (options.starter !== false) {
    const { deliverToStarter } = await delivery();
    await deliverToStarter({
      actor: options.starter,
      conversationId,
      eventKey,
      key,
      nowMs,
      queue: options.queue,
      state: options.state,
      update: readUpdate,
    });
  }
  try {
    const watches = await findUpdateWatches(
      conversationId,
      key,
      nowMs,
      options.state,
    );
    if (watches.length === 0 || (await options.skip?.())) return;
    const ready = await readUpdate();
    if (!ready) return;
    const { deliverAgentUpdate } = await delivery();
    await deliverAgentUpdate({
      conversationId,
      eventKey,
      nowMs,
      queue: options.queue,
      state: options.state,
      update: ready,
      watches,
    });
  } catch (error) {
    logException(error, "conversation.watch.publish.failed", {
      "app.conversation.id": conversationId,
      "app.event.event_type": AGENT_UPDATE_EVENT_TYPE,
    });
  }
}
