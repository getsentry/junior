/**
 * Delivery of one agent update to the starter and the Watches of a
 * Conversation. The starter of a child agent gets the update as its child's
 * `<agent-result>`. Each Watch gets the same `<agent-result>`, as data under
 * the intent that the watcher wrote for the Watch. The update text never
 * adds instructions.
 */
import type { Actor } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { canReadConversation } from "@/api/conversations/access";
import {
  renderAgentResult,
  type AgentUpdate,
  type AgentUpdateStatus,
} from "@/chat/agent-invocations/agent-update";
import { readChildConversationSender } from "@/chat/agent-invocations/child-input";
import { getPersonStopTurnId } from "@/chat/agent-invocations/ids";
import { recordChildAgentEnded } from "@/chat/agent-invocations/markers";
import { enqueueStarterUpdate } from "@/chat/agent-invocations/result";
import { AGENT_UPDATE_EVENT_TYPE } from "@/chat/agent-invocations/result-event-type";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
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
import {
  isAgentResourceType,
  starterWatchId,
  type MatchedWatch,
  type UpdateKey,
} from "./watch-events";

const SUMMARIES: Record<AgentUpdateStatus, string> = {
  blocked: "The conversation is blocked.",
  done: "The conversation finished a Turn.",
  failed: "A Turn of the conversation failed.",
  stopped: "The conversation stopped.",
  waiting: "The conversation waits on a person.",
};

// A note is one line of runtime context, so it keeps only the start of a
// child's long final text.
const LEAD_NOTE_TEXT_MAX_LENGTH = 1_000;

// A Lead hears a child's `done` as a note, so the note carries what the
// child said.
function leadDoneSummary(update: AgentUpdate): string {
  const text = update.text.trim().slice(0, LEAD_NOTE_TEXT_MAX_LENGTH);
  return text ? `${SUMMARIES.done} It said: ${text}` : SUMMARIES.done;
}

/**
 * Deliver one agent update to each matched Watch whose Conversation may
 * still read the target. The access check runs before the update text
 * reaches the watcher. A Watch that names the update as quiet gives a note
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
            !isAgentResourceType(current.resourceType) ||
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

// The key of the starter's message for one update. A Turn keys it by its
// Turn id, so a retry or the report of a lost worker adds nothing.
function starterMessageKey(
  key: Exclude<UpdateKey, { type: "waiting" }>,
): string {
  switch (key.type) {
    case "turn":
    case "turn_failed":
      return key.turnId;
    case "stopped":
      return getPersonStopTurnId(key.stoppedAtMs);
  }
}

/**
 * Deliver one agent update of a child agent to the agent that started it.
 * The stored parent edge is the starter's Watch: it never expires, and the
 * parent's Turn runs as `actor`, never with more authority than the work
 * that the update reports. A Conversation without a parent has no starter,
 * and its update is not read.
 */
export async function deliverToStarter(args: {
  actor?: Actor | undefined;
  conversationId: string;
  eventKey: string;
  key: UpdateKey;
  nowMs: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter | undefined;
  update: () => Promise<AgentUpdate | undefined>;
}): Promise<void> {
  const { key } = args;
  // TODO(dcramer): Tell the starter about a wait, as `design/agent-teams.md`
  // states. Today only the Watches on the child hear it.
  if (key.type === "waiting") return;
  const sender = await readChildConversationSender(args.conversationId);
  if (!sender) return;
  const update = await args.update();
  const status = update?.status;
  if (!update || !status || status === "waiting") return;
  const messageKey = starterMessageKey(key);
  // A Lead gets its children's `done` as a note. The person reads the result
  // in the child, so the Lead has nothing to say about it.
  if (status === "done" && sender.parentHearsDoneAsNote === true) {
    await recordChildAgentEnded(args.conversationId, "success", {
      state: args.state,
    });
    await addQuietEventNote({
      event: {
        eventKey: args.eventKey,
        eventType: AGENT_UPDATE_EVENT_TYPE,
        identifier: args.conversationId,
        namespace: CORE_EVENT_NAMESPACE,
        occurredAtMs: args.nowMs,
        trustedSummary: leadDoneSummary(update),
      },
      subscription: {
        conversationId: sender.parentConversationId,
        id: starterWatchId(args.conversationId),
        label: `Child agent ${sender.agentName ?? sender.title ?? args.conversationId}`,
      },
    });
    return;
  }
  await enqueueStarterUpdate({
    actor: args.actor ?? EVENT_SYSTEM_ACTOR,
    messageKey,
    nowMs: args.nowMs,
    queue: args.queue,
    sender,
    state: args.state,
    turnId: messageKey,
    update: { status, text: update.text },
  });
}
