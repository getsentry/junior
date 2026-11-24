import type { StateAdapter } from "chat";
import type { Actor } from "@/chat/actor";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import {
  EVENT_WAIT_MS,
  type EventMailboxMetadata,
} from "@/chat/events/notification";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import {
  enqueueAutomatedInput,
  getConversationStoppedAtMs,
} from "@/chat/conversations/session-stop";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { getConversationStore } from "@/chat/db";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  listActiveMailboxTurns,
  resolveMailboxTurnWork,
  type MailboxTurnWork,
} from "@/chat/task-execution/mailbox-turn";
import {
  childWorkEnded,
  parentResultActor,
  type DeliverToParent,
  type ParentResult,
} from "./parent-result";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  getConversationWorkState,
  type RenderInboundText,
} from "@/chat/task-execution/store";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import { listTurnSummaries } from "@/chat/task-execution/checkpoint";
import { readChildConversationSender } from "./child-input";
import {
  resultAuthorId,
  withAgentInvocationResultActors,
} from "./result-actors";
import { getAgentReplyMessageId, getTurnReplyKey } from "./ids";
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
  AGENT_INVOCATION_EVENT_NAMESPACE,
  AGENT_MESSAGE_EVENT_TYPE,
  AGENT_UPDATE_EVENT_TYPE,
} from "./result-event-type";
import { renderAgentResult } from "./agent-update";
import type { ChildAgent, ChildAgentSender } from "./types";

/**
 * How one child result that reaches the parent ended, or `waiting` while the
 * child waits on a person's answer to its Inbox item.
 */
type ResultStatus = "blocked" | "completed" | "failed" | "stopped" | "waiting";

/**
 * What a child sends its parent: a Turn's result, or a `waiting` update when
 * it asks a person. A `waiting` update ends nothing.
 */
type ChildUpdate = ParentResult | { kind: "waiting"; text: string };

/**
 * Render the parent agent input for one child agent result as one
 * `<agent-result>`, the agent update that a Watch on the child also gets.
 * The system prompt says what to do for each status, so the input repeats no
 * guidance.
 */
function renderResultInput(
  sender: ChildAgentSender,
  result: { output: string; status: ResultStatus },
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
 * then sees every `reply` that reached the parent, also one that a sibling
 * sent at the same moment, so two siblings cannot each name the other.
 */
function renderResultUnderLock(
  sender: ChildAgentSender,
  result: { output: string; status: ResultStatus },
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
 * sibling whose `reply` is among them has answered.
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
  const inboundMessageId = `agent-invocation:${senderId}:message:${args.messageKey}`;
  const summary = `${childAgentLabel(args.sender)} sent a message.`;
  const metadata = senderEventMetadata(args.actor, {
    eventKey: inboundMessageId,
    eventType: AGENT_MESSAGE_EVENT_TYPE,
    identifier: senderId,
    namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
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

const RESULT_SUMMARIES = {
  blocked: "is blocked.",
  completed: "finished.",
  failed: "failed.",
  reply: "replied.",
  stopped: "was stopped.",
  waiting: "waits on a person.",
} as const;

/**
 * Append the result of one child agent Turn to its parent mailbox and wake
 * the parent: a `reply`, which the parent reads as a completed
 * `<agent-result>` or, while the child still works, as a message, or a
 * completed, blocked, failed, or stopped result. `sender` names the child,
 * and `actor` is the Actor of the child's Turn; the parent never runs with
 * more authority than it. The key of the result, the `reply` tool call id or the
 * Turn id, keys the message, so a repeat call is safe.
 */
export async function enqueueChildResultToParent(args: {
  actor: Actor;
  result: ChildUpdate;
  messageKey: string;
  nowMs?: number;
  queue: ConversationWorkQueue;
  sender: ChildAgentSender;
  state?: StateAdapter | undefined;
  /** The child Turn that sent the result. */
  turnId: string;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const senderId = args.sender.childConversationId;
  const inboundMessageId = getAgentReplyMessageId(senderId, args.messageKey);
  const rendered =
    args.result.kind === "reply"
      ? { output: args.result.reply.text, status: "completed" as const }
      : { output: args.result.text, status: args.result.kind };
  // A child may message its parent more than once. A `reply`, or a person's
  // final text, while the child still works is a message, not its result,
  // and does not count as the child's answer for `waiting_on`.
  const stillWorks =
    (args.result.kind === "reply" || args.result.kind === "completed") &&
    (await childAgentStillWorks(senderId));
  const text = stillWorks
    ? renderMessageInput(args.sender, rendered.output)
    : renderResultInput(args.sender, rendered, []);
  const metadata = {
    ...senderEventMetadata(args.actor, {
      eventKey: inboundMessageId,
      eventType: AGENT_UPDATE_EVENT_TYPE,
      identifier: senderId,
      namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
      ...(stillWorks ? undefined : { status: rendered.status }),
      trustedSummary: `${childAgentLabel(args.sender)} ${stillWorks ? "sent a message." : RESULT_SUMMARIES[args.result.kind]}`,
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
      args.result.kind !== "stopped" &&
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

const PARENT_RESULT_OUTCOMES = {
  blocked: "blocked",
  completed: "success",
  failed: "error",
  reply: "success",
  stopped: "aborted",
} as const satisfies Record<ParentResult["kind"], SubagentOutcome>;

/**
 * Tell the parent of a child agent that the child asked a person with an
 * Inbox item and waits on the answer, so the parent does not ask again. The
 * update gives no authority, so the parent runs it as the Event system Actor.
 * The item keys it, so a later update of the same item reports nothing new.
 * A Conversation with no parent sends nothing.
 */
export async function enqueueChildWaitingToParent(args: {
  conversationId: string;
  inboxItemId: string;
  queue: ConversationWorkQueue;
  text: string;
}): Promise<void> {
  const sender = await readChildConversationSender(args.conversationId);
  if (!sender) return;
  await enqueueChildResultToParent({
    actor: EVENT_SYSTEM_ACTOR,
    messageKey: `waiting:${args.inboxItemId}`,
    queue: args.queue,
    result: {
      kind: "waiting",
      text: `Asked a person with Inbox item ${args.inboxItemId}. Their answer goes to this child agent.\nQuestion: ${args.text}`,
    },
    sender,
    turnId: `waiting:${args.inboxItemId}`,
  });
}

/**
 * Report to the parent of a child agent that a person dismissed the child's
 * Inbox item. A dismiss starts no Turn, like for a root owner, so the child's
 * quiet end that waited on the answer reports now, the way a Turn that ends
 * with `noReply` does: only when the child has no other work, as the Event
 * system Actor. A Conversation with no parent sends nothing.
 */
export async function enqueueChildDismissToParent(args: {
  conversationId: string;
  addedByTurnId: string | undefined;
  inboxItemId: string;
  queue: ConversationWorkQueue;
  text: string;
}): Promise<void> {
  const closed = `${args.text}\nIt closed with no answer`;
  // A Turn that still runs, such as the one that asked, reports its own end,
  // and it then sees the item closed. The parent gets the dismiss now as a
  // message, so that end is not a bare completion.
  const [work, turns] = await Promise.all([
    getConversationWorkState({ conversationId: args.conversationId }),
    listActiveMailboxTurns(args.conversationId),
  ]);
  if ((work?.runningInboundMessageIds.length ?? 0) > 0 || turns.length > 0) {
    const sender = await readChildConversationSender(args.conversationId);
    if (!sender) return;
    await enqueueAgentMessageToParent({
      actor: EVENT_SYSTEM_ACTOR,
      messageKey: `dismissed:${args.inboxItemId}`,
      queue: args.queue,
      sender,
      text: `${closed}.`,
    });
    return;
  }
  // The child's last Turn ended quietly only while it waited. A Turn that
  // reported, such as one with a notice still open, ended the wait already.
  // Its id also keys the result, so a repeat dismiss sends nothing new.
  // The Turn index expires, so a late dismiss falls back to the Turn that
  // added the item.
  const turnId =
    (await listTurnSummaries(args.conversationId))[0]?.turnId ??
    args.addedByTurnId;
  if (!turnId || !(await childWorkEnded(args.conversationId, turnId))) return;
  await createDeliverToParent({ queue: args.queue })({
    actor: EVENT_SYSTEM_ACTOR,
    conversationId: args.conversationId,
    result: {
      kind: "completed",
      text: `${closed}, so this child agent did not continue.`,
    },
    turnId,
  });
}

/**
 * Build the parent delivery of child agent Turns. The child Conversation
 * names the child for the parent.
 */
export function createDeliverToParent(options: {
  queue: ConversationWorkQueue;
  state?: StateAdapter | undefined;
}): DeliverToParent {
  return async ({ actor, result, conversationId, turnId }) => {
    const sender = await readChildConversationSender(conversationId);
    if (!sender) {
      throw new Error(`Conversation ${conversationId} has no parent agent`);
    }
    await recordChildAgentEnded(
      conversationId,
      PARENT_RESULT_OUTCOMES[result.kind],
      options,
    );
    await enqueueChildResultToParent({
      actor,
      result,
      messageKey:
        result.kind === "reply"
          ? getTurnReplyKey(turnId, result.reply.toolCallId)
          : turnId,
      queue: options.queue,
      sender,
      state: options.state,
      turnId,
    });
  };
}

/**
 * End the work of a child Conversation whose last attempt lost its worker.
 * Its open markers end with `error`. Then the child tells its parent that it
 * failed, as a failed Turn does.
 */
export function createEndStoppedChildWork(options: {
  queue: ConversationWorkQueue;
}): (
  conversationId: string,
  inboundMessageIds: readonly string[],
) => Promise<void> {
  const deliverToParent = createDeliverToParent(options);
  return async (conversationId, inboundMessageIds) => {
    // The worker gave up on all of the child's input.
    await recordChildAgentEnded(conversationId, "error", {
      includeWaiting: true,
    });
    const conversation = await getConversationStore().get({ conversationId });
    if (
      !conversation ||
      turnBehavior({ kind: conversation.kind, personInput: false })
        .failureNotice !== "parent"
    ) {
      return;
    }
    const turns = await listActiveMailboxTurns(conversationId);
    // A Turn sends its `reply` before it saves, so a lost worker can follow
    // a reply that the parent already has. Its Turn id comes from its record
    // or, before the first save, from its input, which is still pending.
    // `inboundMessageIds` also holds the input of earlier Turns.
    const work = await getConversationWorkState({ conversationId });
    const pending = work?.execution.pendingMessages ?? [];
    const turnIds = new Set([
      ...turns.map((turn) => turn.turnId),
      ...pending.map((message) =>
        buildDeterministicTurnId(message.inboundMessageId),
      ),
    ]);
    const sender = await readChildConversationSender(conversationId);
    if (
      sender &&
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
    await deliverToParent({
      actor: parentResultActor(
        turn?.actor ?? EVENT_SYSTEM_ACTOR,
        turn?.source?.kind,
      ),
      result: {
        kind: "failed",
        text: `This ${conversation.kind} stopped because its worker failed repeatedly.`,
      },
      conversationId,
      turnId: turn?.turnId ?? `lost:${inboundMessageIds.at(-1) ?? "input"}`,
    });
  };
}

/**
 * Build the worker for all work of a child Conversation. The caller selects
 * it from the stored kind of the Conversation, never from a Turn Source.
 * Every input, such as a parent task or message, a person's Message in a
 * Thread, a Watch Event, or a reply of the child's own child agent, runs on
 * the Conversation loop, like input to a root.
 */
export function createChildConversationWorker(options: {
  runTurn: (
    context: ConversationWorkerContext,
    work: MailboxTurnWork,
  ) => Promise<ConversationWorkerResult>;
  state?: StateAdapter | undefined;
}) {
  return async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    const work = await resolveMailboxTurnWork(context);
    const kept = work ? await withAgentInvocationResultActors(work) : undefined;
    if (!kept) {
      // No open Turn is left for an empty wake, such as a late stop request,
      // or a stop or parent check dropped every input.
      await context.attempt.ack();
      return { status: "completed" };
    }
    const result = await options.runTurn(context, kept);
    if (result.status === "completed") {
      // A Turn that sent no result, such as a `noReply` Turn, ends the
      // child's markers here.
      await recordChildAgentEnded(context.conversationId, "success", options);
    }
    return result;
  };
}
