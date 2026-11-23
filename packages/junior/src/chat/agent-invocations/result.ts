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
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { closeOpenTodosOfChild } from "@/chat/todos/store";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  listActiveMailboxTurns,
  resolveMailboxTurnWork,
  type MailboxTurnWork,
} from "@/chat/task-execution/mailbox-turn";
import type { DeliverToParent, ParentResult } from "./parent-result";
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
import { getAgentReplyMessageId, getTurnReplyKey } from "./ids";
import {
  childMessageSenderMetadata,
  listChildMessages,
  type ChildMessage,
} from "./child-message";
import { childAgentStillWorks } from "./store";
import { renderUntrustedTag } from "@/chat/input-tags";
import { listUnreportedSiblingAgents } from "./list";
import { recordChildAgentEnded, type SubagentOutcome } from "./markers";
import {
  AGENT_INVOCATION_EVENT_NAMESPACE,
  AGENT_MESSAGE_EVENT_TYPE,
  AGENT_REPLY_EVENT_TYPE,
} from "./result-event-type";
import type { ChildAgent, ChildAgentSender } from "./types";

// TODO(dcramer): Add an `agent_invocation.needs_input` Event type when a child
// can pause for input or auth instead of failing (#881).
const AGENT_INVOCATION_RESULT_MAX_LENGTH = 12_000;

/** How one child result that reaches the parent ended. */
type ResultStatus = "blocked" | "completed" | "failed" | "stopped";

/**
 * Render the parent agent input for one child agent result as one
 * `<agent-result>`. A child agent wrote the output, so it is escaped data.
 * `status` and `waiting_on` are runtime facts. The system prompt says what to
 * do for each status, so the input repeats no guidance.
 */
function renderResultInput(
  sender: ChildAgentSender,
  result: { output: string; status: ResultStatus },
  openSiblings: readonly ChildAgent[],
): string {
  const output = result.output
    .trim()
    .slice(0, AGENT_INVOCATION_RESULT_MAX_LENGTH);
  return renderUntrustedTag(
    "agent-result",
    {
      conversation_id: sender.childConversationId,
      name: sender.agentName,
      source: "child_agent",
      status: result.status,
      title: sender.title,
      // Fan-out: one Turn per result would post partial findings. Name the
      // open siblings so the parent can wait for them.
      waiting_on: openSiblings.length
        ? openSiblings.map(siblingLabel).join(", ")
        : undefined,
    },
    "A child agent that you started",
    output || "(empty)",
  );
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
 * Drop the child's open To-dos of the parent before the parent reads that
 * the child was stopped.
 */
async function dropTodosOfStoppedChild(
  sender: ChildAgentSender,
  nowMs: number,
): Promise<void> {
  await closeOpenTodosOfChild(getSqlExecutor(), {
    childConversationId: sender.childConversationId,
    nowMs,
    parentConversationId: sender.parentConversationId,
    status: "dropped",
  });
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
  return renderUntrustedTag(
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
  result: ParentResult;
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
  // A child may message its parent more than once. A `reply` while the
  // child still works is a message, not its result, and does not count as
  // the child's answer for `waiting_on`.
  const stillWorks =
    args.result.kind === "reply" && (await childAgentStillWorks(senderId));
  const text = stillWorks
    ? renderMessageInput(args.sender, rendered.output)
    : renderResultInput(args.sender, rendered, []);
  const metadata = {
    ...senderEventMetadata(args.actor, {
      eventKey: inboundMessageId,
      eventType: AGENT_REPLY_EVENT_TYPE,
      identifier: senderId,
      namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
      trustedSummary: `${childAgentLabel(args.sender)} ${stillWorks ? "sent a message." : RESULT_SUMMARIES[args.result.kind]}`,
    }),
    ...childMessageSenderMetadata({
      conversationId: senderId,
      turnId: args.turnId,
    }),
  };
  // A `stopped` result drops the child's open To-dos. Only the first send
  // drops them: a retry must not drop To-dos assigned after it.
  if (
    args.result.kind === "stopped" &&
    !(
      await readParentChildMessages(
        args.sender.parentConversationId,
        args.state,
      )
    ).some((message) => message.inboundMessageId === inboundMessageId)
  ) {
    await dropTodosOfStoppedChild(args.sender, nowMs);
  }
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
      actor: turn?.actor ?? EVENT_SYSTEM_ACTOR,
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
