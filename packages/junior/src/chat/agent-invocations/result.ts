import type { StateAdapter } from "chat";
import type { Actor } from "@/chat/actor";
import { credentialContextForActor } from "@/chat/credentials/context";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  EVENT_WAIT_MS,
  eventBatchLabel,
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
  type InboundMessage,
} from "@/chat/task-execution/store";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import { createAgentInvocationFromLatest } from "./create";
import type { SendAgentResult } from "./finish";
import {
  getAgentInvocationIdForEvents,
  getAgentInvocationIdForMessage,
  getAgentInvocationIdForResult,
  getAgentInvocationResultMessageId,
} from "./ids";
import {
  getAgentInvocation,
  getLatestAgentInvocationForConversation,
  isParentTask,
} from "./store";
import {
  getConversationStoppedAtMs,
  isWatchEvent,
} from "@/chat/conversations/session-stop";
import { renderUntrustedTag } from "@/chat/input-tags";
import { eventReviewItemInputs } from "@/chat/review-items/prompt-input";
import { listUnreportedSiblingAgents } from "./list";
import {
  agentInvocationResultEventType,
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
import {
  AGENT_INVOCATION_RESULT_MAX_LENGTH,
  renderTaskError,
  renderTaskResult,
} from "./report";

const AGENT_INVOCATION_EVENT_NAMESPACE = "junior";
// TODO(dcramer): Add an `agent_invocation.needs_input` Event type when a child
// can pause for input or auth instead of failing (#881).
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
 * Render what one terminal agent invocation tells its parent. A parent task
 * sends its report log, and its error before that. A row that a runtime
 * without a report log wrote holds its text already.
 */
function resultText(invocation: TerminalAgentInvocation): string {
  const completed = invocation.status === "completed";
  if (invocation.reportLog === undefined || !isParentTask(invocation)) {
    return completed ? invocation.result : invocation.errorMessage;
  }
  return completed
    ? renderTaskResult(invocation.reportLog)
    : renderTaskError(invocation.errorMessage, invocation.reportLog);
}

/**
 * Render the parent agent input for one terminal agent invocation as one
 * `<agent-result>`. A child agent wrote the output, so it is escaped data.
 * `status` and `waiting_on` are runtime facts. The system prompt says what to
 * do for each status, so the input repeats no guidance.
 */
function renderResultInput(
  invocation: TerminalAgentInvocation,
  openSiblings: readonly ChildAgent[],
): string {
  const output = resultText(invocation)
    .trim()
    .slice(0, AGENT_INVOCATION_RESULT_MAX_LENGTH);
  return renderUntrustedTag(
    "agent-result",
    {
      conversation_id: invocation.childConversationId,
      name: invocation.agentName,
      source: "child_agent",
      status: invocation.status,
      title: invocation.title,
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

/** Build the parent Inbound message for one terminal agent invocation. */
function buildResultInboundMessage(
  invocation: TerminalAgentInvocation,
  nowMs: number,
  openSiblings: readonly ChildAgent[],
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
      text: renderResultInput(invocation, openSiblings),
    },
    receivedAtMs: nowMs,
    source: "event",
  };
}

/**
 * Append one terminal agent invocation result to the parent mailbox and wake
 * the parent. `finishAgentInvocation` calls it before it saves the terminal
 * status. Repeat calls are safe: the inbox drops a message id that it has.
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
  const nowMs = options.nowMs ?? Date.now();
  const openSiblings = await listUnreportedSiblingAgents(
    invocation.parentConversationId,
    invocation.childConversationId,
  );
  await appendAndEnqueueInboundMessage({
    message: buildResultInboundMessage(invocation, nowMs, openSiblings),
    queue: options.queue,
    queueDelayMs: EVENT_WAIT_MS,
    state: options.state,
  });
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

type ChildAgentInput = {
  invocationId: string;
  kind: "message" | "result";
  /** The result reports a stop that the child's own worker saw. */
  stopped?: true;
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
  if (!isAgentInvocationResultEventType(metadata.event.eventType)) {
    return undefined;
  }
  return {
    invocationId: metadata.event.identifier,
    kind: "result",
    ...(metadata.event.eventType === agentInvocationResultEventType("stopped")
      ? { stopped: true }
      : undefined),
  };
}

/**
 * Return whether a stop of the child after this result was sent skipped it,
 * so it starts no work. A message that a child sent before its stop is still
 * delivered, and so is the report of a person's stop of the child.
 */
async function isSkippedAgentResult(
  input: ChildAgentInput,
  invocation: AgentInvocation,
): Promise<boolean> {
  return (
    input.kind === "result" &&
    !input.stopped &&
    (await getConversationStoppedAtMs(invocation.childConversationId)) !==
      undefined
  );
}

/**
 * Read the agent invocation of one result or message and check that it
 * belongs to a child of the Conversation that received it. A result is sent
 * before its agent invocation saves its end, so the row can still be open.
 */
async function getChildAgentInputInvocation(
  message: InboundMessage,
  input: ChildAgentInput,
): Promise<AgentInvocation> {
  const invocation = await getAgentInvocation(input.invocationId);
  if (
    !invocation ||
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
  // Watch Events start work once a person or the parent ended the stop of
  // the child.
  if (
    (latest.status === "stopped" ||
      (await getConversationStoppedAtMs(context.conversationId)) !==
        undefined) &&
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
        { replyTo: "parent" },
      ).join("\n\n"),
      inputLabel: eventBatchLabel(messages),
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
    if (await isSkippedAgentResult(input, source)) {
      continue;
    }
    const invocation = await createAgentInvocationFromLatest({
      input: message.input.text.trim(),
      inputLabel: `${input.kind === "result" ? "Result" : "Message"} from ${childAgentLabel(source).toLowerCase()}${source.title ? `: ${source.title}` : ""}`,
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
    maxAgentDepth?: number;
    queue: ConversationWorkQueue;
    sendResult?: SendAgentResult;
    state?: StateAdapter;
  },
) {
  const invocationWorker = createAgentInvocationWorker(agentRunner, {
    ...options,
    enqueueMessage: async (sender, messageKey, text) =>
      await enqueueAgentMessageToParent({
        messageKey,
        queue: options.queue,
        sender,
        state: options.state,
        text,
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
      return (await isSkippedAgentResult(input, invocation))
        ? undefined
        : { ...entry, actor: invocation.actor };
    }),
  );
  const kept = batch.filter((entry) => entry !== undefined);
  return kept.length > 0 ? { kind: "mailbox", batch: kept } : undefined;
}
