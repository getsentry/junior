import type { StateAdapter } from "chat";
import type { Actor } from "@/chat/actor";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import type { EventMailboxMetadata } from "@/chat/events/mailbox-metadata";
import { EVENT_WAIT_MS } from "@/chat/events/notification";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import {
  enqueueAutomatedInput,
  getConversationStoppedAtMs,
} from "@/chat/conversations/session-stop";
import { publishAgentUpdate } from "@/chat/conversations/watch-events";
import { getConversationStore } from "@/chat/db";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import { listActiveMailboxTurns } from "@/chat/task-execution/mailbox-turn";
import { parentResultActor } from "./parent-result";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  getConversationWorkState,
  type RenderInboundText,
} from "@/chat/task-execution/store";
import { readChildConversationSender } from "./child-input";
import { resultAuthorId } from "./sender-actors";
import { getAgentMessageId, getAgentReplyMessageId } from "./ids";
import {
  childMessageSenderMetadata,
  listChildMessages,
  type ChildMessage,
} from "./child-message";
import { childAgentStillWorks } from "./store";
import { renderDataTag } from "@/chat/input-tags";
import { listUnreportedSiblingAgents } from "./list";
import { recordChildAgentEnded, type SubagentOutcome } from "./markers";
import {
  AGENT_EVENT_NAMESPACE,
  AGENT_MESSAGE_EVENT_TYPE,
  AGENT_UPDATE_EVENT_TYPE,
} from "./result-event-type";
import { renderAgentResult, type AgentUpdateStatus } from "./agent-update";
import type { ChildAgent, ChildAgentSender } from "./types";

// TODO(dcramer): Add a `waiting` agent update from a child when it can pause
// for input or auth instead of failing (#881).

/**
 * Render the parent agent input for one child agent result as one
 * `<agent-result>`, the agent update that a Watch on the child also gets.
 * The system prompt says what to do for each status, so the input repeats no
 * guidance.
 */
function renderResultInput(
  sender: ChildAgentSender,
  result: { output: string; status: AgentUpdateStatus },
  openSiblings: readonly ChildAgent[],
): string {
  return renderAgentResult({
    conversationId: sender.childConversationId,
    name: sender.agentName,
    source: "child_agent",
    title: sender.title,
    update: { status: result.status, text: result.output },
    // Fan-out: one Turn per result would post partial findings. Name the
    // open siblings so the parent can wait for them.
    waitingOn: openSiblings.length
      ? openSiblings.map(siblingLabel).join(", ")
      : undefined,
  });
}

function siblingLabel(sibling: ChildAgent): string {
  return sibling.agentName ?? sibling.title ?? sibling.childConversationId;
}

/**
 * Render one `<agent-result>` under the parent's mailbox lock. `waiting_on`
 * then sees every result that reached the parent, also one that a sibling
 * sent at the same moment, so two siblings cannot each name the other.
 */
function renderResultUnderLock(
  sender: ChildAgentSender,
  result: { output: string; status: AgentUpdateStatus },
): RenderInboundText {
  return async (parentInboundMessageIds, messageSenders) =>
    renderResultInput(
      sender,
      result,
      await listUnreportedSiblingAgents(
        sender.parentConversationId,
        sender.childConversationId,
        listChildMessages(parentInboundMessageIds, messageSenders),
      ),
    );
}

/**
 * Read every child reply and result that reached the parent's mailbox. A
 * sibling whose result is among them has answered.
 */
async function readParentChildMessages(
  parentConversationId: string,
  state: StateAdapter | undefined,
): Promise<ChildMessage[]> {
  const work = await getConversationWorkState({
    conversationId: parentConversationId,
    state,
  });
  return listChildMessages(
    work?.execution.inboundMessageIds ?? [],
    work?.execution.messageSenders ?? {},
  );
}

function childAgentLabel(sender: ChildAgentSender): string {
  return sender.agentName ? `Child agent "${sender.agentName}"` : "Child agent";
}

/**
 * Mailbox metadata of a reply or message from a child. It carries the Actor
 * of the child's Turn, so the parent runs with no more authority than that
 * Turn. The author id must match it.
 */
function senderEventMetadata(
  actor: Actor,
  event: EventMailboxMetadata["event"],
): EventMailboxMetadata & { actor: Actor } {
  return { kind: "event", event, actor };
}

function renderMessageInput(sender: ChildAgentSender, text: string): string {
  return renderDataTag(
    "agent-message",
    {
      conversation_id: sender.childConversationId,
      name: sender.agentName,
      source: "child_agent",
      title: sender.title,
    },
    "A child agent that you started",
    text.trim(),
  );
}

/**
 * Append one message from a child agent to its parent mailbox and wake the
 * parent. `sender` names the child, and `actor` is the Actor of the child's
 * Turn. The parent handles the message like a result. Repeat calls with the
 * same `messageKey` are safe.
 */
export async function enqueueAgentMessageToParent(args: {
  actor: Actor;
  messageKey: string;
  nowMs?: number;
  queue: ConversationWorkQueue;
  sender: ChildAgentSender;
  state?: StateAdapter | undefined;
  text: string;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const senderId = args.sender.childConversationId;
  const inboundMessageId = getAgentMessageId(senderId, args.messageKey);
  const summary = `${childAgentLabel(args.sender)} sent a message.`;
  const metadata = senderEventMetadata(args.actor, {
    eventKey: inboundMessageId,
    eventType: AGENT_MESSAGE_EVENT_TYPE,
    identifier: senderId,
    namespace: AGENT_EVENT_NAMESPACE,
    trustedSummary: summary,
  });
  await enqueueAutomatedInput({
    message: {
      conversationId: args.sender.parentConversationId,
      createdAtMs: nowMs,
      delivery: "defer",
      inboundMessageId,
      input: {
        authorId: resultAuthorId(args.actor),
        authorIdentityId: SYSTEM_IDENTITY_ID,
        metadata,
        text: renderMessageInput(args.sender, args.text),
      },
      receivedAtMs: nowMs,
      source: "event",
    },
    queue: args.queue,
    queueDelayMs: EVENT_WAIT_MS,
    state: args.state,
  });
}

/** The status of an update that reaches the starter's mailbox. A wait is a note. */
type StarterUpdateStatus = Exclude<AgentUpdateStatus, "waiting">;

const RESULT_SUMMARIES: Record<StarterUpdateStatus, string> = {
  blocked: "is blocked.",
  done: "finished.",
  failed: "failed.",
  stopped: "was stopped.",
};

const UPDATE_OUTCOMES = {
  blocked: "blocked",
  done: "success",
  failed: "error",
  stopped: "aborted",
} as const satisfies Record<StarterUpdateStatus, SubagentOutcome>;

/**
 * Append one agent update of a child agent to its starter's mailbox and
 * wake the starter: what the update reached the parent edge with. A `done`
 * update while the child still works reaches the parent as a message.
 * `sender` names the child, and `actor` is the Actor that the parent's Turn
 * runs as; the parent never runs with more authority than the child's Turn.
 * `messageKey` keys the message, so a repeat call is safe. The child's
 * markers end first.
 */
export async function enqueueStarterUpdate(args: {
  actor: Actor;
  messageKey: string;
  nowMs?: number;
  queue: ConversationWorkQueue;
  sender: ChildAgentSender;
  state?: StateAdapter | undefined;
  /** The child Turn that sent the update. */
  turnId: string;
  update: { status: StarterUpdateStatus; text: string };
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const senderId = args.sender.childConversationId;
  const { status } = args.update;
  await recordChildAgentEnded(senderId, UPDATE_OUTCOMES[status], {
    state: args.state,
  });
  const inboundMessageId = getAgentReplyMessageId(senderId, args.messageKey);
  const rendered = { output: args.update.text, status };
  // A child may message its parent more than once. Final text while the
  // child still works is a message, not its result, and does not count as
  // the child's answer for `waiting_on`.
  const stillWorks =
    status === "done" && (await childAgentStillWorks(senderId));
  const text = stillWorks
    ? renderMessageInput(args.sender, rendered.output)
    : renderResultInput(args.sender, rendered, []);
  const metadata = {
    ...senderEventMetadata(args.actor, {
      eventKey: inboundMessageId,
      eventType: AGENT_UPDATE_EVENT_TYPE,
      identifier: senderId,
      namespace: AGENT_EVENT_NAMESPACE,
      ...(stillWorks ? undefined : { status }),
      trustedSummary: `${childAgentLabel(args.sender)} ${stillWorks ? "sent a message." : RESULT_SUMMARIES[status]}`,
    }),
    ...childMessageSenderMetadata({
      conversationId: senderId,
      turnId: args.turnId,
    }),
  };
  await enqueueAutomatedInput({
    message: {
      conversationId: args.sender.parentConversationId,
      createdAtMs: nowMs,
      delivery: "defer",
      inboundMessageId,
      input: {
        authorId: resultAuthorId(args.actor),
        authorIdentityId: SYSTEM_IDENTITY_ID,
        metadata,
        text,
      },
      receivedAtMs: nowMs,
      source: "event",
    },
    renderText: async (parentInboundMessageIds, messageSenders) =>
      // A stop drops the child's unread replies from the parent's mailbox.
      // One sent before the stop can reach this lock after that drop, so a
      // stopped sender's reply is dropped here. The `stopped` result
      // reports that stop, so it stays.
      status !== "stopped" &&
      (await getConversationStoppedAtMs(senderId)) !== undefined
        ? undefined
        : stillWorks
          ? text
          : await renderResultUnderLock(args.sender, rendered)(
              parentInboundMessageIds,
              messageSenders,
            ),
    queue: args.queue,
    queueDelayMs: EVENT_WAIT_MS,
    state: args.state,
  });
}

/**
 * End the work of a child Conversation whose last attempt lost its worker.
 * Its open markers end with `error`. Then the child tells its starter that
 * it failed, as a failed Turn does.
 */
export function createEndStoppedChildWork(options: {
  queue: ConversationWorkQueue;
}): (
  conversationId: string,
  inboundMessageIds: readonly string[],
) => Promise<void> {
  return async (conversationId, inboundMessageIds) => {
    // The worker gave up on all of the child's input.
    await recordChildAgentEnded(conversationId, "error", {
      includeWaiting: true,
    });
    const conversation = await getConversationStore().get({ conversationId });
    const sender = await readChildConversationSender(conversationId);
    if (!conversation || !sender) {
      return;
    }
    const turns = await listActiveMailboxTurns(conversationId);
    // A Turn reports when it records its end, before it acks its input, so
    // a lost worker can follow a result that the parent already has. Its
    // Turn id comes from its record or, before the first save, from its
    // input, which is still pending.
    // `inboundMessageIds` also holds the input of earlier Turns.
    const work = await getConversationWorkState({ conversationId });
    const pending = work?.execution.pendingMessages ?? [];
    const turnIds = new Set([
      ...turns.map((turn) => turn.turnId),
      ...pending.map((message) =>
        buildDeterministicTurnId(message.inboundMessageId),
      ),
    ]);
    if (
      (
        await readParentChildMessages(sender.parentConversationId, undefined)
      ).some(
        (message) =>
          message.sender.conversationId === conversationId &&
          turnIds.has(message.sender.turnId),
      )
    ) {
      return;
    }
    const [turn] = turns;
    await publishAgentUpdate(
      conversationId,
      {
        type: "turn_failed",
        turnId: turn?.turnId ?? `lost:${inboundMessageIds.at(-1) ?? "input"}`,
      },
      {
        queue: options.queue,
        starter: parentResultActor(
          turn?.actor ?? EVENT_SYSTEM_ACTOR,
          turn?.source?.kind,
        ),
        update: async () => ({
          status: "failed",
          text: `This ${conversation.kind} stopped because its worker failed repeatedly.`,
        }),
      },
    );
  };
}
