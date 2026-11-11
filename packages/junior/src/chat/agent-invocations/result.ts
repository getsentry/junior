import type { StateAdapter } from "chat";
import type { Actor } from "@/chat/actor";
import { credentialContextForActor } from "@/chat/credentials/context";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  EVENT_WAIT_MS,
  eventBatchMessageMeta,
  isEventMailboxMetadata,
  renderEventBatchInputs,
  timerWatchCredentialSubject,
  type EventMailboxMetadata,
} from "@/chat/events/notification";
import {
  getEventBatchDelayMs,
  parseEventMessages,
  type MailboxTurnWork,
} from "@/chat/task-execution/mailbox-turn";
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
import { createAgentInvocationFromLatest } from "./create";
import {
  getAgentInvocationIdForEvents,
  getAgentInvocationIdForMessage,
  getAgentInvocationIdForResult,
  getAgentInvocationResultMessageId,
  getAgentReplyMessageId,
  isAgentReplyMessageId,
} from "./ids";
import {
  getAgentInvocation,
  getLatestAgentInvocationForConversation,
  isTerminalAgentInvocation,
  markAgentInvocationParentMailboxAppended,
  reportReplacedWithoutOpenWork,
  sendsResultToParent,
} from "./store";
import { isWatchEvent } from "@/chat/conversations/session-stop";
import { renderUntrustedTag } from "@/chat/input-tags";
import type { Reply } from "@/chat/turn-answer";
import { eventReviewItemInputs } from "@/chat/review-items/prompt-input";
import { listUnreportedSiblingAgents } from "./list";
import {
  agentInvocationResultEventType,
  AGENT_REPLY_EVENT_TYPE,
  isAgentInvocationResultEventType,
} from "./result-event-type";
import type {
  AgentInvocation,
  ChildAgent,
  TerminalAgentInvocation,
} from "./types";
import {
  createAgentInvocationWorker,
  enqueueAgentInvocation,
  resolveAgentInvocationId,
} from "./work";

const AGENT_INVOCATION_EVENT_NAMESPACE = "junior";
// TODO(dcramer): Add an `agent_invocation.needs_input` Event type when a child
// can pause for input or auth instead of failing (#881).
const AGENT_INVOCATION_RESULT_MAX_LENGTH = 12_000;
/** Event type of a message that a child agent sends to its parent. */
const AGENT_MESSAGE_EVENT_TYPE = "agent.message";

/**
 * Return the Inbound message author id for results sent by one Actor.
 * `selectContiguousTurnBatch` in `task-execution/worker.ts` puts messages in
 * one attempt only when their author ids and sources match. Mid-Turn drains
 * take only `interrupt` messages, and results are `defer`. So results never
 * share a Turn and its credentials with another Actor or with watch Events.
 * Keep this id unique per Actor if either rule changes.
 */
function resultAuthorId(actor: Actor): string {
  switch (actor.platform) {
    case "system":
      return `agent-invocation:system:${actor.name}`;
    case "slack":
      return `agent-invocation:slack:${actor.teamId}:${actor.userId}`;
    default:
      return `agent-invocation:${actor.platform}:${actor.userId}`;
  }
}

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
  sender: AgentInvocation,
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
  sender: AgentInvocation,
  result: { output: string; status: TerminalAgentInvocation["status"] },
): RenderInboundText {
  return async (parentInboundMessageIds) =>
    renderResultInput(
      sender,
      result,
      await listUnreportedSiblingAgents(
        sender.parentConversationId,
        sender.childConversationId,
        parentInboundMessageIds,
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
    state?: StateAdapter;
  },
): Promise<void> {
  if (invocation.parentMailboxStatus !== "pending") {
    return;
  }
  const nowMs = options.nowMs ?? Date.now();
  const parentInboundMessageIds = await readParentInboundMessageIds(
    invocation.parentConversationId,
    options.state,
  );
  if (!sendsResultToParent(invocation, parentInboundMessageIds)) {
    await markAgentInvocationParentMailboxAppended(
      invocation.invocationId,
      nowMs,
    );
    const replied = parentInboundMessageIds.some((messageId) =>
      isAgentReplyMessageId(messageId, invocation.invocationId),
    );
    // A child that sent its parent nothing starts no later agent invocation
    // there, so a `replaced` result of the parent reports now.
    const replaced = replied
      ? undefined
      : await reportReplacedWithoutOpenWork(
          invocation.parentConversationId,
          nowMs,
        );
    if (replaced && isTerminalAgentInvocation(replaced)) {
      await enqueueAgentInvocationResult(replaced, options);
    }
    return;
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
 * Read the ids of every message that reached the parent's mailbox. A sibling
 * whose `reply` is among them has answered.
 */
async function readParentInboundMessageIds(
  parentConversationId: string,
  state: StateAdapter | undefined,
): Promise<readonly string[]> {
  const work = await getConversationWorkState({
    conversationId: parentConversationId,
    state,
  });
  return work?.execution.inboundMessageIds ?? [];
}

function childAgentLabel(invocation: AgentInvocation): string {
  return invocation.agentName
    ? `Child agent "${invocation.agentName}"`
    : "Child agent";
}

function renderMessageInput(sender: AgentInvocation, text: string): string {
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
 * parent. `sender` is the open agent invocation of the child. The parent
 * handles the message like a result: a root parent runs an Event Turn, and a
 * child parent starts a new agent invocation. Repeat calls with the same
 * `messageKey` are safe.
 */
export async function enqueueAgentMessageToParent(args: {
  messageKey: string;
  nowMs?: number;
  queue: ConversationWorkQueue;
  sender: AgentInvocation;
  state?: StateAdapter;
  text: string;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const inboundMessageId = `agent-invocation:${args.sender.invocationId}:message:${args.messageKey}`;
  const summary = `${childAgentLabel(args.sender)} sent a message.`;
  const metadata: EventMailboxMetadata = {
    kind: "event",
    event: {
      eventKey: inboundMessageId,
      eventType: AGENT_MESSAGE_EVENT_TYPE,
      identifier: args.sender.invocationId,
      namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
      trustedSummary: summary,
    },
  };
  await appendAndEnqueueInboundMessage({
    message: {
      conversationId: args.sender.parentConversationId,
      createdAtMs: nowMs,
      delivery: "defer",
      inboundMessageId,
      input: {
        authorId: resultAuthorId(args.sender.actor),
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

/**
 * Append the `reply` of one child agent Turn to its parent mailbox and wake
 * the parent. The parent reads it as a completed `<agent-result>`. `sender`
 * is the agent invocation of the Turn, open or not. The reply's tool call id
 * keys the message, so a repeat call is safe.
 */
export async function enqueueAgentReplyToParent(args: {
  nowMs?: number;
  queue: ConversationWorkQueue;
  reply: Reply;
  sender: AgentInvocation;
  state?: StateAdapter;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const inboundMessageId = getAgentReplyMessageId(
    args.sender.invocationId,
    args.reply.toolCallId,
  );
  const result = { output: args.reply.text, status: "completed" as const };
  const metadata: EventMailboxMetadata = {
    kind: "event",
    event: {
      eventKey: inboundMessageId,
      eventType: AGENT_REPLY_EVENT_TYPE,
      identifier: args.sender.invocationId,
      namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
      trustedSummary: `${childAgentLabel(args.sender)} replied.`,
    },
  };
  await appendAndEnqueueInboundMessage({
    message: {
      conversationId: args.sender.parentConversationId,
      createdAtMs: nowMs,
      delivery: "defer",
      inboundMessageId,
      input: {
        authorId: resultAuthorId(args.sender.actor),
        authorIdentityId: SYSTEM_IDENTITY_ID,
        metadata,
        text: renderResultInput(args.sender, result, []),
      },
      receivedAtMs: nowMs,
      source: "event",
    },
    renderText: renderResultUnderLock(args.sender, result),
    queue: args.queue,
    queueDelayMs: EVENT_WAIT_MS,
    state: args.state,
  });
}

type ChildAgentInput = {
  invocationId: string;
  kind: "message" | "reply" | "result";
};

/**
 * Read the agent invocation that one result or message Event refers to: the
 * finished child work for a result, or the open sender work for a message.
 */
function childAgentInput(message: InboundMessage): ChildAgentInput | undefined {
  const metadata = message.input.metadata;
  if (
    !isEventMailboxMetadata(metadata) ||
    metadata.event.namespace !== AGENT_INVOCATION_EVENT_NAMESPACE
  ) {
    return undefined;
  }
  if (metadata.event.eventType === AGENT_MESSAGE_EVENT_TYPE) {
    return { invocationId: metadata.event.identifier, kind: "message" };
  }
  // A reply, like a message, can arrive before its sender's agent invocation
  // ends.
  if (metadata.event.eventType === AGENT_REPLY_EVENT_TYPE) {
    return { invocationId: metadata.event.identifier, kind: "reply" };
  }
  return isAgentInvocationResultEventType(metadata.event.eventType)
    ? { invocationId: metadata.event.identifier, kind: "result" }
    : undefined;
}

/**
 * Return whether a stop after this result or reply was sent skipped it, so it
 * starts no work. A message that a child sent before its stop is still
 * delivered.
 */
function isSkippedAgentResult(
  input: ChildAgentInput,
  invocation: AgentInvocation,
): boolean {
  return (
    input.kind !== "message" &&
    isTerminalAgentInvocation(invocation) &&
    invocation.parentMailboxStatus === "skipped"
  );
}

/**
 * Read the agent invocation of one result or message and check that it
 * belongs to a child of the Conversation that received it.
 */
async function getChildAgentInputInvocation(
  message: InboundMessage,
  input: ChildAgentInput,
): Promise<AgentInvocation> {
  const invocation = await getAgentInvocation(input.invocationId);
  if (
    !invocation ||
    (input.kind === "result" && !isTerminalAgentInvocation(invocation)) ||
    invocation.parentConversationId !== message.conversationId
  ) {
    throw new Error(
      `Agent invocation ${input.kind} ${input.invocationId} does not belong to ${message.conversationId}`,
    );
  }
  return invocation;
}

/**
 * Give mailbox input that reaches a child Conversation to that child: results
 * and messages from its own child agents, and its own watch events. A child
 * Conversation has no Location, so it cannot run an Event Turn. Each input
 * starts a new agent invocation on the child instead, and that invocation
 * reports to the child's parent. Returns undefined for work that is not
 * mailbox input for a child Conversation.
 */
async function startAgentInvocationsForChildInput(
  context: ConversationWorkerContext,
  options: { queue: ConversationWorkQueue; state?: StateAdapter },
): Promise<ConversationWorkerResult | undefined> {
  const messages = context.attempt.messages;
  const inputs = messages.map(childAgentInput);
  const isAgentInput = inputs.every((input) => input !== undefined);
  const events = isAgentInput ? [] : parseEventMessages(messages);
  if (messages.length === 0 || (!isAgentInput && events.length === 0)) {
    return undefined;
  }
  const latest = await getLatestAgentInvocationForConversation(
    context.conversationId,
  );
  if (!latest) {
    return undefined;
  }
  // A stopped child takes no new work, even from input sent before the stop.
  // A tree stop leaves a `replaced` agent invocation with its finished status
  // and marks it `skipped`, so that also means stopped. Watch Events start
  // work once a person or the parent ended the stop of the child.
  if (
    (latest.status === "stopped" ||
      (isTerminalAgentInvocation(latest) &&
        latest.parentMailboxStatus === "skipped")) &&
    // The session stop already saved every Watch Event of a stopped
    // Conversation, so these reach a child that is no longer stopped.
    (isAgentInput || !messages.every(isWatchEvent))
  ) {
    await context.attempt.ack();
    return { status: "completed" };
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
        await eventReviewItemInputs(messages),
      ).join("\n\n"),
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
    const input = inputs[index]!;
    const source = await getChildAgentInputInvocation(message, input);
    if (isSkippedAgentResult(input, source)) {
      continue;
    }
    const invocation = await createAgentInvocationFromLatest({
      input: message.input.text.trim(),
      invocationId:
        input.kind === "result"
          ? getAgentInvocationIdForResult(source.invocationId)
          : getAgentInvocationIdForMessage(message.inboundMessageId),
      latest,
    });
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
 * it from the stored parent of the Conversation, never from a Turn Source. It
 * starts agent invocations for child input, then runs the agent invocation
 * that owns the work. Work that no agent invocation owns is an error.
 */
export function createChildConversationWorker(
  agentRunner: AgentRunner,
  options: {
    enqueueResult?: (invocation: TerminalAgentInvocation) => Promise<void>;
    maxAgentDepth?: number;
    queue: ConversationWorkQueue;
    state?: StateAdapter;
  },
) {
  const invocationWorker = createAgentInvocationWorker(agentRunner, {
    ...options,
    sendReply: async (sender, reply) =>
      await enqueueAgentReplyToParent({
        queue: options.queue,
        reply,
        sender,
        state: options.state,
      }),
  });
  return async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    const started = await startAgentInvocationsForChildInput(context, options);
    if (started) {
      return started;
    }
    const invocationId = await resolveAgentInvocationId(context);
    if (!invocationId) {
      throw new Error(
        `Child conversation ${context.conversationId} has no agent invocation for this work`,
      );
    }
    return await invocationWorker(context, invocationId);
  };
}

/**
 * Run each agent invocation result or message as the Actor that triggered the
 * child, user or system. This is on purpose: the result continues that
 * Actor's work. The Actor comes from SQL, not from mailbox metadata, so the
 * parent Turn has the same authority it had at spawn time. A result that a
 * stop skipped is dropped. Returns undefined when no input is left.
 *
 * TODO(dcramer): Pass the delegated credential subject of a system Actor, such
 * as a timer watch Turn, when system Turns can spawn children that need it.
 */
export async function withAgentInvocationResultActors(
  work: MailboxTurnWork,
): Promise<MailboxTurnWork | undefined> {
  if (work.kind !== "mailbox") {
    return work;
  }
  const batch = await Promise.all(
    work.batch.map(async (entry) => {
      const input = childAgentInput(entry.message);
      if (!input) {
        return entry;
      }
      const invocation = await getChildAgentInputInvocation(
        entry.message,
        input,
      );
      return isSkippedAgentResult(input, invocation)
        ? undefined
        : { ...entry, actor: invocation.actor };
    }),
  );
  const kept = batch.filter((entry) => entry !== undefined);
  return kept.length > 0 ? { kind: "mailbox", batch: kept } : undefined;
}
