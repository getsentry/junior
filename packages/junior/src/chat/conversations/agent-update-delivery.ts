/**
 * Delivery of one agent update to the Watches on a Conversation. Each Watch
 * gets the `<agent-result>` that a parent gets from a child agent, as data
 * under the intent that the watcher wrote for the Watch. The update text
 * never adds instructions.
 */
import type { StateAdapter } from "chat";
import { canReadConversation } from "@/api/conversations/access";
import {
  renderAgentResult,
  type AgentUpdate,
  type AgentUpdateStatus,
} from "@/chat/agent-invocations/agent-update";
import { AGENT_UPDATE_EVENT_TYPE } from "@/chat/agent-invocations/result-event-type";
import { enqueueAutomatedInput } from "@/chat/conversations/session-stop";
import { getConversationStore, getDb } from "@/chat/db";
import { CORE_EVENT_NAMESPACE, eventGuidance } from "@/chat/events/catalog";
import {
  addQuietEventNote,
  createEventInboundMessage,
  EVENT_WAIT_MS,
  type EventNotification,
} from "@/chat/events/notification";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { deliverWatch, isQuietEvent } from "@/chat/events/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { renderTaskInput } from "@/chat/task-input";
import { CONVERSATION_RESOURCE_TYPE, type MatchedWatch } from "./watch-events";

const SUMMARIES: Record<AgentUpdateStatus, string> = {
  blocked: "The conversation is blocked.",
  completed: "The conversation finished a Turn.",
  failed: "A Turn of the conversation failed.",
  stopped: "The conversation stopped.",
  waiting: "The conversation waits on a person.",
};

/**
 * Deliver one agent update to each matched Watch whose Conversation may
 * still read the target. The access check runs before the update text
 * reaches the watcher. A Watch that names the update as quiet gets a note
 * that starts no Turn.
 */
export async function deliverAgentUpdate(args: {
  conversationId: string;
  eventKey: string;
  nowMs: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter | undefined;
  update: AgentUpdate;
  watches: readonly MatchedWatch[];
}): Promise<void> {
  const conversation = await getConversationStore().get({
    conversationId: args.conversationId,
  });
  const agentResult = renderAgentResult({
    conversationId: args.conversationId,
    source: "watch",
    title: conversation?.title ?? undefined,
    update: args.update,
  });
  const event: EventNotification = {
    eventKey: args.eventKey,
    eventType: AGENT_UPDATE_EVENT_TYPE,
    identifier: args.conversationId,
    namespace: CORE_EVENT_NAMESPACE,
    occurredAtMs: args.nowMs,
    trustedSummary: SUMMARIES[args.update.status],
  };
  const appGuidance = eventGuidance(
    getEventCatalog(),
    CORE_EVENT_NAMESPACE,
    AGENT_UPDATE_EVENT_TYPE,
  );
  // As in Event ingest: Watches that start a Turn go first, so a Quiet Event
  // adds no note to a Conversation whose Turn already gets this update.
  const ordered = [...args.watches].sort(
    (left, right) =>
      Number(isQuietEvent(left.watch, left.eventType)) -
      Number(isQuietEvent(right.watch, right.eventType)),
  );
  const turnConversations = new Set<string>();
  const errors: unknown[] = [];
  /* oxlint-disable no-await-in-loop -- Deliver to Watches in order; each takes its own lock. */
  for (const { eventType, watch } of ordered) {
    try {
      await deliverWatch({
        eventType,
        identifier: args.conversationId,
        namespace: CORE_EVENT_NAMESPACE,
        nowMs: args.nowMs,
        state: args.state,
        subscription: watch,
        deliver: async (current) => {
          if (
            current.resourceType !== CONVERSATION_RESOURCE_TYPE ||
            !(await canReadConversation(
              getDb(),
              current.conversationId,
              args.conversationId,
            ))
          ) {
            return false;
          }
          if (isQuietEvent(current, eventType)) {
            if (!turnConversations.has(current.conversationId)) {
              await addQuietEventNote({ event, subscription: current });
            }
            return true;
          }
          const guidance = [appGuidance, current.guidance?.[eventType]]
            .filter((text): text is string => Boolean(text?.trim()))
            .join(" ");
          const result = await enqueueAutomatedInput({
            message: createEventInboundMessage({
              event,
              status: args.update.status,
              subscription: current,
              text: renderTaskInput({
                about: current.label,
                agentResult,
                event: AGENT_UPDATE_EVENT_TYPE,
                guidance: guidance || undefined,
                instructions: current.intent,
              }),
            }),
            queue: args.queue,
            queueDelayMs: EVENT_WAIT_MS,
            state: args.state,
          });
          if (result.status === "held") return false;
          turnConversations.add(current.conversationId);
          return result.status === "appended";
        },
      });
    } catch (error) {
      errors.push(error);
    }
  }
  /* oxlint-enable no-await-in-loop */
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to deliver one or more watches");
  }
}
