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
import { listWatches } from "@/chat/events/store";
import { getConversationStore } from "@/chat/db";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  listActiveMailboxTurns,
  resolveMailboxTurnWork,
  type MailboxTurnWork,
} from "@/chat/task-execution/mailbox-turn";
import { parentResultActor } from "./parent-result";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  getConversationWorkState,
  type RenderInboundText,
} from "@/chat/task-execution/store";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import { readChildConversationSender } from "./child-input";
import {
  resultAuthorId,
  withAgentInvocationResultActors,
} from "./result-actors";
import { getAgentReplyMessageId } from "./ids";
import {
  childMessageSenderMetadata,
  listChildMessages,
  type ChildMessage,
} from "./child-message";
import { childAgentStillWorks } from "./store";
import { renderDataTag } from "@/chat/input-tags";
import { remindsNoReplyForChildStatus } from "@/chat/conversations/kind-behavior";
import { NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { hasWaitingParentWork, listUnreportedSiblingAgents } from "./list";
import { recordChildAgentEnded, type SubagentOutcome } from "./markers";
import {
  AGENT_INVOCATION_EVENT_NAMESPACE,
  AGENT_MESSAGE_EVENT_TYPE,
  AGENT_UPDATE_EVENT_TYPE,
} from "./result-event-type";
import { renderAgentResult, type AgentUpdateStatus } from "./agent-update";
import type { ChildAgent, ChildAgentSender } from "./types";

/**
 * Render the parent agent input for one child agent result as one
 * `<agent-result>`, the agent update that a Watch on the child also gets.
 * The system prompt says what to do for each status. A Lead's done result
 * also reminds it that a status update needs no reply.
 */
function renderResultInput(
  sender: ChildAgentSender,
  result: { output: string; status: AgentUpdateStatus },
  openSiblings: readonly ChildAgent[],
): string {
  const agentResult = renderAgentResult({
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
  return result.status === "done"
    ? withNoReplyReminder(sender, agentResult)
    : agentResult;
}

const NO_REPLY_REMINDER = `If this is only a status update with nothing a member needs, end with \`${NO_REPLY_TOOL_NAME}\`.`;

// A blocked, failed, or stopped child needs the parent to act, so only a
// child's done result and its messages get the reminder.
function withNoReplyReminder(sender: ChildAgentSender, input: string): string {
  return remindsNoReplyForChildStatus(sender.parentKind)
    ? `${input}\n${NO_REPLY_REMINDER}`
    : input;
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
  return withNoReplyReminder(
    sender,
    renderDataTag(
      "agent-message",
      {
        conversation_id: sender.childConversationId,
        name: sender.agentName,
        source: "child_agent",
        title: sender.title,
      },
      "A child agent that you started",
      text.trim(),
    ),
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

const RESULT_SUMMARIES: Record<AgentUpdateStatus, string> = {
  blocked: "is blocked.",
  done: "finished.",
  failed: "failed.",
  stopped: "was stopped.",
  waiting: "waits on a person.",
};

const UPDATE_OUTCOMES = {
  blocked: "blocked",
  done: "success",
  failed: "error",
  stopped: "aborted",
} as const satisfies Record<
  Exclude<AgentUpdateStatus, "waiting">,
  SubagentOutcome
>;

/**
 * Append one agent update of a child agent to its starter's mailbox and
 * wake the starter: what the update reached the parent edge with. A `done`
 * update while the child still works reaches the parent as a message.
 * `sender` names the child, and `actor` is the Actor that the parent's Turn
 * runs as; the parent never runs with more authority than the child's Turn.
 * `messageKey` keys the message, so a repeat call is safe. The child's
 * markers end first, except for a `waiting` update, which ends nothing.
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
  update: { status: AgentUpdateStatus; text: string };
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const senderId = args.sender.childConversationId;
  const { status } = args.update;
  if (status !== "waiting") {
    await recordChildAgentEnded(senderId, UPDATE_OUTCOMES[status], {
      state: args.state,
    });
  }
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
      namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
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
  const key = `waiting:${args.inboxItemId}`;
  await enqueueStarterUpdate({
    actor: EVENT_SYSTEM_ACTOR,
    messageKey: key,
    queue: args.queue,
    sender,
    turnId: key,
    update: {
      status: "waiting",
      text: `Asked a person with Inbox item ${args.inboxItemId}. Their answer goes to this child agent.\nQuestion: ${args.text}`,
    },
  });
}

/**
 * Report to the parent of a child agent that a person dismissed the child's
 * Inbox question. A dismiss starts no Turn, like for a root owner. When that
 * ends the child's work, the child reports `done` now, as the Event system
 * Actor. Otherwise the parent gets the dismiss as a message, so it does not
 * keep waiting on that answer. The item keys both, so a repeat dismiss sends
 * nothing new. A Conversation with no parent sends nothing.
 */
export async function enqueueChildDismissToParent(args: {
  conversationId: string;
  inboxItemId: string;
  queue: ConversationWorkQueue;
  text: string;
}): Promise<void> {
  const sender = await readChildConversationSender(args.conversationId);
  if (!sender) return;
  const key = `dismissed:${args.inboxItemId}`;
  const closed = `${args.text}\nIt closed with no answer`;
  if (await dismissEndsChildWork(args.conversationId)) {
    await enqueueStarterUpdate({
      actor: EVENT_SYSTEM_ACTOR,
      messageKey: key,
      queue: args.queue,
      sender,
      turnId: key,
      update: {
        status: "done",
        text: `${closed}, so this child agent did not continue.`,
      },
    });
    return;
  }
  // A Turn that still runs, such as the one that asked, reports its own end,
  // and other work reports when it ends.
  await enqueueAgentMessageToParent({
    actor: EVENT_SYSTEM_ACTOR,
    messageKey: key,
    queue: args.queue,
    sender,
    text: `${closed}.`,
  });
}

// A dismiss ends the child's work when no Turn of the child runs, none of its
// own child agents still works, it has no active Watch or Timer, and no input
// waits to run a later Turn.
async function dismissEndsChildWork(conversationId: string): Promise<boolean> {
  const [work, turns, stillWorks, watches, waiting] = await Promise.all([
    getConversationWorkState({ conversationId }),
    listActiveMailboxTurns(conversationId),
    childAgentStillWorks(conversationId),
    listWatches({ conversationId }),
    hasWaitingParentWork(conversationId),
  ]);
  return (
    (work?.runningInboundMessageIds.length ?? 0) === 0 &&
    turns.length === 0 &&
    !stillWorks &&
    watches.length === 0 &&
    !waiting
  );
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
