import { mapBounded } from "@/chat/fan-out";
import type { StateAdapter } from "chat";
import type { Actor } from "@/chat/actor";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  EVENT_WAIT_MS,
  eventBatchMessageMeta,
  renderEventBatchInputs,
  timerWatchCredentialSubject,
  type EventMailboxMetadata,
} from "@/chat/events/notification";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { credentialContextForActor } from "@/chat/credentials/context";
import { eventInboxItemInputs } from "@/chat/inbox-items/prompt-input";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { closeOpenTodosOfChild } from "@/chat/todos/store";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  getEventBatchDelayMs,
  listActiveMailboxTurns,
  parseEventMessages,
  resolveMailboxTurnWork,
  type MailboxTurnWork,
} from "@/chat/task-execution/mailbox-turn";
import type {
  DeliverToParent,
  ParentResult,
} from "@/chat/task-execution/conversation-turn";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  appendAndEnqueueInboundMessage,
  getConversationWorkState,
  type InboundMessage,
  type RenderInboundText,
} from "@/chat/task-execution/store";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import {
  childAgentInput,
  getChildAgentInputSender,
  readChildConversationSender,
  routeChildInput,
} from "./child-input";
import { logDroppedParentMessage } from "./parent-message";
import { readParentMessage } from "./parent-message-input";
import { createAgentInvocationFromLatest } from "./create";
import {
  resultAuthorId,
  withAgentInvocationResultActors,
} from "./result-actors";
import {
  getAgentInvocationIdForEvents,
  getAgentInvocationIdForMessage,
  getAgentInvocationIdForResult,
  getAgentInvocationResultMessageId,
  getAgentReplyMessageId,
  getAgentInvocationTurnId,
  getTurnReplyKey,
} from "./ids";
import {
  childMessageSenderMetadata,
  hasAgentInvocationReply,
  listChildMessages,
  ownAgentInvocation,
  type ChildMessage,
} from "./child-message";
import type { InboundMessageSender } from "@/chat/task-execution/message-sender";
import {
  childAgentStillWorks,
  getLatestAgentInvocationForConversation,
  isTerminalAgentInvocation,
  listAgentInvocationsForConversation,
  TERMINAL_AGENT_INVOCATION_STATUSES,
  markAgentInvocationParentMailboxAppended,
  NON_TERMINAL_AGENT_INVOCATION_STATUSES,
  reportReplacedWithoutOpenWork,
  sendsResultToParent,
} from "./store";
import { renderUntrustedTag } from "@/chat/input-tags";
import { listUnreportedSiblingAgents } from "./list";
import { recordChildAgentEnded } from "./markers";
import {
  AGENT_INVOCATION_EVENT_NAMESPACE,
  AGENT_MESSAGE_EVENT_TYPE,
  agentInvocationResultEventType,
  AGENT_REPLY_EVENT_TYPE,
} from "./result-event-type";
import type {
  ChildAgent,
  ChildAgentSender,
  TerminalAgentInvocation,
} from "./types";
import {
  createAgentInvocationWorker,
  endActiveAgentInvocations,
  endAgentInvocationsOfStoppedWork,
  enqueueAgentInvocation,
  resolveAgentInvocationId,
} from "./work";

// TODO(dcramer): Add an `agent_invocation.needs_input` Event type when a child
// can pause for input or auth instead of failing (#881).
const AGENT_INVOCATION_RESULT_MAX_LENGTH = 12_000;

/**
 * Error messages can contain text from tools or providers, so the trusted
 * summary in the mailbox metadata has only the status.
 */
function trustedSummary(
  invocation: TerminalAgentInvocation,
  agent: string,
): string {
  switch (invocation.status) {
    case "completed":
      return `${agent} finished its task.`;
    case "blocked":
      return `${agent} is blocked.`;
    case "failed":
      return `${agent} failed.`;
    case "stopped":
      return `${agent} was stopped.`;
  }
}

/**
 * Render the parent agent input for one child agent result as one
 * `<agent-result>`. A child agent wrote the output, so it is escaped data.
 * `status` and `waiting_on` are runtime facts. The system prompt says what to
 * do for each status, so the input repeats no guidance.
 */
function renderResultInput(
  sender: ChildAgentSender,
  result: { output: string; status: TerminalAgentInvocation["status"] },
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
  result: { output: string; status: TerminalAgentInvocation["status"] },
): RenderInboundText {
  return async (parentInboundMessageIds, messageSenders) =>
    renderResultInput(
      sender,
      result,
      await listUnreportedSiblingAgents(
        sender.parentConversationId,
        sender.childConversationId,
        await listChildMessages(parentInboundMessageIds, messageSenders),
      ),
    );
}

function terminalResult(invocation: TerminalAgentInvocation): {
  output: string;
  status: TerminalAgentInvocation["status"];
} {
  return {
    output:
      invocation.status === "completed"
        ? invocation.result
        : invocation.errorMessage,
    status: invocation.status,
  };
}

/**
 * Build the parent Inbound message for one terminal agent invocation. Its
 * text names no siblings: `renderResultUnderLock` adds `waiting_on`.
 */
function buildResultInboundMessage(
  invocation: TerminalAgentInvocation,
  nowMs: number,
): InboundMessage {
  const summary = trustedSummary(invocation, childAgentLabel(invocation));
  const metadata: EventMailboxMetadata = {
    kind: "event",
    event: {
      eventKey: invocation.invocationId,
      eventType: agentInvocationResultEventType(invocation.status),
      identifier: invocation.invocationId,
      namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
      trustedSummary: summary,
    },
    ...childMessageSenderMetadata({
      agentInvocationId: invocation.invocationId,
      conversationId: invocation.childConversationId,
      turnId: getAgentInvocationTurnId(invocation.invocationId),
    }),
  };
  return {
    conversationId: invocation.parentConversationId,
    createdAtMs: invocation.terminalAtMs,
    delivery: "defer",
    inboundMessageId: getAgentInvocationResultMessageId(
      invocation.invocationId,
    ),
    input: {
      authorId: resultAuthorId(invocation.actor),
      // An agent wrote the result, so the system Identity is its author.
      authorIdentityId: SYSTEM_IDENTITY_ID,
      metadata,
      text: renderResultInput(invocation, terminalResult(invocation), []),
    },
    receivedAtMs: nowMs,
    source: "event",
  };
}

/**
 * Append one terminal agent invocation result to the parent mailbox and wake
 * the parent. Repeat calls are safe.
 *
 * Results do not go through `admitAutomatedTurn`, so the automated-turn limit
 * never drops them. Result Turns still count toward that limit.
 * TODO(dcramer): Add a per-parent total invocation limit as the loop guard
 * for spawn -> result -> spawn chains (#881).
 */
export async function enqueueAgentInvocationResult(
  invocation: TerminalAgentInvocation,
  options: {
    nowMs?: number;
    queue: ConversationWorkQueue;
    state?: StateAdapter | undefined;
  },
): Promise<void> {
  if (invocation.parentMailboxStatus !== "pending") {
    return;
  }
  const nowMs = options.nowMs ?? Date.now();
  const parentMessages = await readParentChildMessages(
    invocation.parentConversationId,
    options.state,
  );
  if (!sendsResultToParent(invocation, parentMessages)) {
    await markAgentInvocationParentMailboxAppended(
      invocation.invocationId,
      nowMs,
    );
    const replied = hasAgentInvocationReply(
      parentMessages,
      invocation.invocationId,
    );
    // A child that sent its parent nothing starts no later agent invocation
    // there, so a `replaced` result of the parent reports now.
    const replaced = replied
      ? undefined
      : await reportReplacedWithoutOpenWork(invocation.parentConversationId, {
          nowMs,
        });
    if (replaced && isTerminalAgentInvocation(replaced)) {
      await enqueueAgentInvocationResult(replaced, options);
    }
    return;
  }
  // A `reply` closed them when it was sent, and a quiet Turn sends no result.
  // A retry after the append must not close To-dos assigned after it.
  const resultMessageId = getAgentInvocationResultMessageId(
    invocation.invocationId,
  );
  if (
    !parentMessages.some(
      (message) => message.inboundMessageId === resultMessageId,
    )
  ) {
    await closeTodosForResult(invocation, invocation.status, nowMs);
  }
  await appendAndEnqueueInboundMessage({
    message: buildResultInboundMessage(invocation, nowMs),
    renderText: renderResultUnderLock(invocation, terminalResult(invocation)),
    queue: options.queue,
    queueDelayMs: EVENT_WAIT_MS,
    state: options.state,
  });
  await markAgentInvocationParentMailboxAppended(
    invocation.invocationId,
    nowMs,
  );
}

/**
 * Close the child's open To-dos of the parent before the parent reads the
 * child's result: done when it completed, dropped when it stopped. A
 * blocked or failed child did not finish that work.
 */
async function closeTodosForResult(
  sender: Pick<
    ChildAgentSender,
    "childConversationId" | "parentConversationId"
  >,
  status: TerminalAgentInvocation["status"],
  nowMs: number,
): Promise<void> {
  if (status !== "completed" && status !== "stopped") return;
  await closeOpenTodosOfChild(getSqlExecutor(), {
    childConversationId: sender.childConversationId,
    nowMs,
    parentConversationId: sender.parentConversationId,
    status: status === "completed" ? "done" : "dropped",
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
  return await listChildMessages(
    work?.execution.inboundMessageIds ?? [],
    work?.execution.messageSenders ?? {},
  );
}

function childAgentLabel(sender: ChildAgentSender): string {
  return sender.agentName ? `Child agent "${sender.agentName}"` : "Child agent";
}

/**
 * Mailbox metadata of a reply or message from a child that no Agent
 * invocation names. It carries the Actor of the child's Turn, so the parent
 * runs with no more authority than that Turn. The author id must match it.
 */
function senderEventMetadata(
  sender: ChildAgentSender,
  actor: Actor,
  event: EventMailboxMetadata["event"],
): EventMailboxMetadata & { actor?: Actor } {
  return sender.invocationId
    ? { kind: "event", event }
    : { kind: "event", event, actor };
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
  const senderId = args.sender.invocationId ?? args.sender.childConversationId;
  const inboundMessageId = `agent-invocation:${senderId}:message:${args.messageKey}`;
  const summary = `${childAgentLabel(args.sender)} sent a message.`;
  const metadata = senderEventMetadata(args.sender, args.actor, {
    eventKey: inboundMessageId,
    eventType: AGENT_MESSAGE_EVENT_TYPE,
    identifier: senderId,
    namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
    trustedSummary: summary,
  });
  await appendAndEnqueueInboundMessage({
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
  failed: "failed.",
  reply: "replied.",
  stopped: "was stopped.",
} as const;

/**
 * Append the result of one child agent Turn to its parent mailbox and wake
 * the parent: a `reply`, which the parent reads as a completed
 * `<agent-result>` or, while the child still works, as a message, or a
 * blocked or failed result. `sender` names the child:
 * an agent invocation, open or not, or the child Conversation when none
 * names it. `actor` is the Actor of the child's Turn; the parent never runs
 * with more authority than it. The key of the result, the `reply` tool call
 * id or the Turn id, keys the message, so a repeat call is safe.
 */
export async function enqueueChildResultToParent(args: {
  actor?: Actor;
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
  const actor = args.actor ?? args.sender.actor;
  if (!actor) {
    throw new Error(
      `Reply of ${args.sender.childConversationId} has no Actor for its parent`,
    );
  }
  const senderId = args.sender.invocationId ?? args.sender.childConversationId;
  const inboundMessageId = getAgentReplyMessageId(senderId, args.messageKey);
  const rendered =
    args.result.kind === "reply"
      ? { output: args.result.reply.text, status: "completed" as const }
      : { output: args.result.text, status: args.result.kind };
  const replyTurn: InboundMessageSender = {
    ...(args.sender.invocationId
      ? { agentInvocationId: args.sender.invocationId }
      : undefined),
    conversationId: args.sender.childConversationId,
    turnId: args.turnId,
  };
  // A child may message its parent more than once. A `reply` while the
  // child still works is a message, not its result. Its sender names no
  // agent invocation, so it closes no To-dos and does not count as the
  // child's answer for `waiting_on`.
  const stillWorks =
    args.result.kind === "reply" &&
    (await childAgentStillWorks(
      args.sender.childConversationId,
      ownAgentInvocation(replyTurn),
    ));
  const sender: InboundMessageSender = stillWorks
    ? { conversationId: replyTurn.conversationId, turnId: replyTurn.turnId }
    : replyTurn;
  const text = stillWorks
    ? renderMessageInput(args.sender, rendered.output)
    : renderResultInput(args.sender, rendered, []);
  const metadata = {
    ...senderEventMetadata(args.sender, actor, {
      eventKey: inboundMessageId,
      eventType: AGENT_REPLY_EVENT_TYPE,
      identifier: senderId,
      namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
      trustedSummary: `${childAgentLabel(args.sender)} ${stillWorks ? "sent a message." : RESULT_SUMMARIES[args.result.kind]}`,
    }),
    ...childMessageSenderMetadata(sender),
  };
  // A `reply` of an agent invocation is its result. A reply from a Turn on
  // the Conversation loop is not, so the child's work may go on. Only the
  // first send closes: a retry must not close To-dos assigned after it.
  const replyingInvocationId =
    args.result.kind === "reply" ? ownAgentInvocation(sender) : undefined;
  if (
    replyingInvocationId &&
    !hasAgentInvocationReply(
      await readParentChildMessages(
        args.sender.parentConversationId,
        args.state,
      ),
      replyingInvocationId,
    )
  ) {
    await closeTodosForResult(args.sender, "completed", nowMs);
  }
  await appendAndEnqueueInboundMessage({
    message: {
      conversationId: args.sender.parentConversationId,
      createdAtMs: nowMs,
      delivery: "defer",
      inboundMessageId,
      input: {
        authorId: resultAuthorId(actor),
        authorIdentityId: SYSTEM_IDENTITY_ID,
        metadata,
        text,
      },
      receivedAtMs: nowMs,
      source: "event",
    },
    renderText: async (parentInboundMessageIds, messageSenders) =>
      // A stop drops the unread replies of a Turn on the Conversation loop
      // from the parent's mailbox. One sent before the stop can reach this
      // lock after that drop, so a stopped sender's reply is dropped here.
      // The `stopped` result reports that stop, so it stays.
      args.result.kind !== "stopped" &&
      !ownAgentInvocation(sender) &&
      (await getConversationStoppedAtMs(args.sender.childConversationId)) !==
        undefined
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
  failed: "error",
  reply: "success",
  stopped: "aborted",
} as const satisfies Record<ParentResult["kind"], string>;

/**
 * Build the parent delivery of child agent Turns that run on the
 * Conversation loop. Such a Turn has no open agent invocation, so its
 * newest finished agent invocation names the child for the parent. A child
 * that no agent invocation names is named by its child Conversation.
 */
export function createDeliverToParent(options: {
  queue: ConversationWorkQueue;
  state?: StateAdapter | undefined;
}): DeliverToParent {
  return async ({ actor, result, conversationId, turnId }) => {
    const sender =
      (
        await listAgentInvocationsForConversation(
          conversationId,
          TERMINAL_AGENT_INVOCATION_STATUSES,
        )
      ).at(-1) ?? (await readChildConversationSender(conversationId));
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
 * Its open Agent invocations end as before. Without them, its open markers
 * end with `error`. Then a Task tells its parent that it failed, as a failed
 * Turn does. A Thread keeps the stored failure and its telemetry, and
 * reports the `replaced` result of its parent now, so its grandparent does
 * not wait for it.
 */
export function createEndStoppedChildWork(options: {
  queue: ConversationWorkQueue;
}): (
  conversationId: string,
  inboundMessageIds: readonly string[],
) => Promise<void> {
  const deliverToParent = createDeliverToParent(options);
  return async (conversationId, inboundMessageIds) => {
    const open = await listAgentInvocationsForConversation(
      conversationId,
      NON_TERMINAL_AGENT_INVOCATION_STATUSES,
    );
    if (open.length > 0) {
      await endAgentInvocationsOfStoppedWork(conversationId, inboundMessageIds);
      return;
    }
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
      // A Thread sends no notice, so the `replaced` result of its parent
      // reports now, or the grandparent would wait for it forever. Its own
      // work stops after this, so it does not count as open.
      await reportParentWithoutOpenWork(conversationId, {
        ...options,
        ending: true,
      });
      return;
    }
    const turns = await listActiveMailboxTurns(conversationId);
    // A Turn sends its `reply` before it saves, so a lost worker can follow
    // a reply that the parent already has. Its Turn id comes from its record
    // or, before the first save, from its input, which is still pending.
    // `inboundMessageIds` also holds the input of earlier Turns.
    const pending =
      (await getConversationWorkState({ conversationId }))?.execution
        .pendingMessages ?? [];
    const turnIds = new Set([
      ...turns.map((turn) => turn.turnId),
      ...pending.map((message) =>
        buildDeterministicTurnId(message.inboundMessageId),
      ),
    ]);
    const latest =
      await getLatestAgentInvocationForConversation(conversationId);
    const sender =
      latest ?? (await readChildConversationSender(conversationId));
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
        text: "This task stopped because its worker failed repeatedly.",
      },
      conversationId,
      turnId: turn?.turnId ?? `lost:${inboundMessageIds.at(-1) ?? "input"}`,
    });
  };
}

/**
 * Give input to a child Conversation whose task is not done to that task, as
 * `routeChildInput` decides. Each result or message from its own child
 * agents, or each batch of its watch events while an agent invocation is
 * open, starts a new agent invocation that reports to the parent. Returns
 * undefined when no input goes to an agent invocation: the Conversation loop
 * runs it and drops what a stop skips.
 *
 * TODO(dcramer): Remove with the legacy child worker (#3060 step 7).
 */
async function startAgentInvocationsForChildInput(
  context: ConversationWorkerContext,
  options: { queue: ConversationWorkQueue; state?: StateAdapter | undefined },
): Promise<ConversationWorkerResult | undefined> {
  const messages = context.attempt.messages;
  const latest = await getLatestAgentInvocationForConversation(
    context.conversationId,
  );
  if (messages.length === 0 || !latest) {
    return undefined;
  }
  const stoppedAtMs = await getConversationStoppedAtMs(context.conversationId);
  const routes = await mapBounded(messages, (message) =>
    routeChildInput(message, latest, stoppedAtMs),
  );
  if (!routes.includes("agent invocation")) {
    return undefined;
  }
  const inputs = messages.map(childAgentInput);
  const isAgentInput = messages.every(
    (message, index) =>
      inputs[index] !== undefined || readParentMessage(message) !== undefined,
  );
  const events = isAgentInput ? [] : parseEventMessages(messages);
  if (!isAgentInput && events.length === 0) {
    return undefined;
  }
  if (!isAgentInput) {
    // Watch events wait for the same burst window as on a root.
    const delayMs = getEventBatchDelayMs(messages);
    if (delayMs > 0) {
      return { status: "deferred", delayMs };
    }
    // The events run as the event system Actor, as on a root. A timer may
    // use the grants of the person who set it.
    const { actor, source } = events[0]!;
    const invocation = await createAgentInvocationFromLatest({
      // TODO(dcramer): Keep one content part per input after an agent
      // invocation stores its input as parts.
      input: renderEventBatchInputs(
        messages,
        await eventInboxItemInputs(messages),
      )
        .map((input) => input.text)
        .join("\n\n"),
      invocationId: getAgentInvocationIdForEvents(
        messages[0]!.inboundMessageId,
      ),
      latest,
      runAs: {
        actor,
        credentialContext: credentialContextForActor(
          actor,
          timerWatchCredentialSubject(context.conversationId, messages),
        ),
        source,
      },
    });
    await enqueueAgentInvocation(invocation, {
      ...options,
      eventMeta: eventBatchMessageMeta(messages),
    });
    await context.attempt.ack();
    return { status: "completed" };
  }
  for (const [index, message] of messages.entries()) {
    const parentMessage = readParentMessage(message);
    if (routes[index] === "dropped") {
      if (parentMessage) {
        logDroppedParentMessage(message, parentMessage);
      }
      continue;
    }
    if (parentMessage) {
      // A parent message to a child with an open Agent invocation queues
      // behind it, as `messageAgent` does with a row.
      // oxlint-disable-next-line no-await-in-loop -- Queue invocations in message order.
      await enqueueAgentInvocation(
        // oxlint-disable-next-line no-await-in-loop -- Queue invocations in message order.
        await createAgentInvocationFromLatest({
          input: message.input.text.trim(),
          invocationId: getAgentInvocationIdForMessage(
            message.inboundMessageId,
          ),
          latest,
          runAs: {
            actor: parentMessage.actor,
            credentialContext: parentMessage.credentialContext,
            fork: parentMessage.fork,
            parentToolCallId: parentMessage.parentToolCallId,
          },
        }),
        options,
      );
      continue;
    }
    const input = inputs[index]!;
    // Only an agent invocation sends a result.
    // oxlint-disable-next-line no-await-in-loop -- Queue invocations in message order.
    const { invocation: source } = await getChildAgentInputSender(
      message,
      input,
    );
    // oxlint-disable-next-line no-await-in-loop -- Queue invocations in message order.
    const invocation = await createAgentInvocationFromLatest({
      input: message.input.text.trim(),
      invocationId:
        input.kind === "result" && source
          ? getAgentInvocationIdForResult(source.invocationId)
          : getAgentInvocationIdForMessage(message.inboundMessageId),
      latest,
      // A result continues the work of the Turn that spawned its child
      // agent, with that Turn's Actor and grants, such as a timer Turn that
      // ran on the Conversation loop after `latest` ended.
      ...(input.kind === "result" && source
        ? {
            runAs: {
              actor: source.actor,
              credentialContext: source.credentialContext,
            },
          }
        : undefined),
    });
    // oxlint-disable-next-line no-await-in-loop -- Queue invocations in message order.
    await enqueueAgentInvocation(invocation, {
      ...options,
      eventMeta: eventBatchMessageMeta([message]),
    });
  }
  await context.attempt.ack();
  return { status: "completed" };
}

/**
 * Build the worker for all work of a child Conversation. The caller selects
 * it from the stored kind of the Conversation, never from a Turn Source. A
 * parent task or message runs on its agent invocation. Every other input,
 * such as a person's Message in a Thread, a Watch Event, or a reply or result
 * of the child's own child agent, runs on the Conversation loop,
 * like input to a root.
 */
export function createChildConversationWorker(
  agentRunner: AgentRunner,
  options: {
    enqueueResult?: (invocation: TerminalAgentInvocation) => Promise<void>;
    queue: ConversationWorkQueue;
    runTurn: (
      context: ConversationWorkerContext,
      work: MailboxTurnWork,
    ) => Promise<ConversationWorkerResult>;
    state?: StateAdapter | undefined;
  },
) {
  const invocationWorker = createAgentInvocationWorker(agentRunner, {
    ...options,
    sendReply: async (sender, reply) =>
      await enqueueChildResultToParent({
        result: { kind: "reply", reply },
        messageKey: reply.toolCallId,
        queue: options.queue,
        sender,
        state: options.state,
        turnId: getAgentInvocationTurnId(sender.invocationId),
      }),
  });
  return async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    // A parent task or message, or the open agent invocation, finishes on
    // the agent invocation worker.
    const invocationId = await resolveAgentInvocationId(context);
    if (invocationId) {
      return await invocationWorker(context, invocationId);
    }
    const started = await startAgentInvocationsForChildInput(context, options);
    if (started) {
      return started;
    }
    const work = await resolveMailboxTurnWork(context);
    if (!work) {
      // No open Turn is left for an empty wake, such as a late stop request.
      await context.attempt.ack();
      return { status: "completed" };
    }
    if (work.kind === "mailbox") {
      // A person's Message supersedes an open Agent invocation, as new input
      // does on a root. Other input with an open one started an agent
      // invocation above.
      await endActiveAgentInvocations(context.conversationId, {
        enqueueResult: options.enqueueResult,
        errorMessage:
          "A person sent a Message in this Thread, so this task ended without a result. Send messageAgent again if you still need this work.",
      });
    }
    const kept = await withAgentInvocationResultActors(work);
    if (!kept) {
      // A stop skipped every child result in this input.
      await context.attempt.ack();
      return { status: "completed" };
    }
    const result = await options.runTurn(context, kept);
    if (result.status === "completed") {
      // A Turn that sent no result, such as a Thread's, ends its work here.
      await recordChildAgentEnded(context.conversationId, "success", options);
      await reportParentWithoutOpenWork(context.conversationId, options);
    }
    return result;
  };
}

/**
 * A completed Turn of a child that no Agent invocation names can end the
 * last open work of its parent, such as a Turn that ends with `noReply`. A
 * `replaced` result of that parent then reports, as when a child row ends.
 * A child with a row reports when its row ends, as on `main`.
 *
 * TODO(dcramer): Remove with the `replaced` result (#3060 step 7).
 */
async function reportParentWithoutOpenWork(
  conversationId: string,
  options: {
    ending?: boolean;
    queue: ConversationWorkQueue;
    state?: StateAdapter | undefined;
  },
): Promise<void> {
  if (await getLatestAgentInvocationForConversation(conversationId)) {
    return;
  }
  const sender = await readChildConversationSender(conversationId);
  const replaced = sender
    ? await reportReplacedWithoutOpenWork(sender.parentConversationId, {
        endingChildConversationId: options.ending ? conversationId : undefined,
      })
    : undefined;
  if (replaced && isTerminalAgentInvocation(replaced)) {
    await enqueueAgentInvocationResult(replaced, options);
  }
}
