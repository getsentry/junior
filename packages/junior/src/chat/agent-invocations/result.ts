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
import { eventReviewItemInputs } from "@/chat/review-items/prompt-input";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { getConversationStore } from "@/chat/db";
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
  getChildAgentInputInvocation,
  routeChildInput,
} from "./child-input";
import { createAgentInvocationFromLatest } from "./create";
import {
  getAgentInvocationIdForEvents,
  getAgentInvocationIdForMessage,
  getAgentInvocationIdForResult,
  getAgentInvocationResultMessageId,
  getAgentReplyMessageId,
  getTurnReplyKey,
  isAgentReplyMessageId,
  parseTurnReplyMessageId,
} from "./ids";
import {
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
import {
  AGENT_INVOCATION_EVENT_NAMESPACE,
  AGENT_MESSAGE_EVENT_TYPE,
  agentInvocationResultEventType,
  AGENT_REPLY_EVENT_TYPE,
} from "./result-event-type";
import type {
  AgentInvocation,
  ChildAgent,
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
 * parent. `sender` names the child, and `actor` is the Actor of the child's
 * Turn. The parent handles the message like a result. Repeat calls with the
 * same `messageKey` are safe.
 */
export async function enqueueAgentMessageToParent(args: {
  actor: Actor;
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
} as const;

/**
 * Append the result of one child agent Turn to its parent mailbox and wake
 * the parent: a `reply`, which the parent reads as a completed
 * `<agent-result>`, or a blocked or failed result. `sender` is the agent
 * invocation that names the child, open or not. `actor` is the Actor of the
 * child's Turn; the parent never runs with more authority than it. The key
 * of the result, the `reply` tool call id or the Turn id, keys the message,
 * so a repeat call is safe.
 */
export async function enqueueChildResultToParent(args: {
  actor?: Actor;
  result: ParentResult;
  messageKey: string;
  nowMs?: number;
  queue: ConversationWorkQueue;
  sender: AgentInvocation;
  state?: StateAdapter;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const inboundMessageId = getAgentReplyMessageId(
    args.sender.invocationId,
    args.messageKey,
  );
  const rendered =
    args.result.kind === "reply"
      ? { output: args.result.reply.text, status: "completed" as const }
      : { output: args.result.text, status: args.result.kind };
  const metadata: EventMailboxMetadata = {
    kind: "event",
    event: {
      eventKey: inboundMessageId,
      eventType: AGENT_REPLY_EVENT_TYPE,
      identifier: args.sender.invocationId,
      namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
      trustedSummary: `${childAgentLabel(args.sender)} ${RESULT_SUMMARIES[args.result.kind]}`,
    },
  };
  await appendAndEnqueueInboundMessage({
    message: {
      conversationId: args.sender.parentConversationId,
      createdAtMs: nowMs,
      delivery: "defer",
      inboundMessageId,
      input: {
        authorId: resultAuthorId(args.actor ?? args.sender.actor),
        authorIdentityId: SYSTEM_IDENTITY_ID,
        metadata,
        text: renderResultInput(args.sender, rendered, []),
      },
      receivedAtMs: nowMs,
      source: "event",
    },
    renderText: renderResultUnderLock(args.sender, rendered),
    queue: args.queue,
    queueDelayMs: EVENT_WAIT_MS,
    state: args.state,
  });
}

/**
 * Build the parent delivery of child agent Turns that run on the
 * Conversation loop. Such a Turn has no open agent invocation, so its
 * newest finished agent invocation names the child for the parent.
 */
export function createDeliverToParent(options: {
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): DeliverToParent {
  return async ({ actor, result, conversationId, turnId }) => {
    const sender = (
      await listAgentInvocationsForConversation(
        conversationId,
        TERMINAL_AGENT_INVOCATION_STATUSES,
      )
    ).at(-1);
    if (!sender) {
      throw new Error(
        `Child conversation ${conversationId} has no agent invocation`,
      );
    }
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
    });
  };
}

/**
 * End the work of a child Conversation whose last attempt lost its worker.
 * Its open agent invocations end as before. A Turn on the Conversation loop
 * has none, so a Task tells its parent that it failed, as a failed Turn
 * does. A Thread keeps the stored failure and its telemetry.
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
    // or, before the first save, from its input.
    const turnIds = new Set([
      ...turns.map((turn) => turn.turnId),
      ...inboundMessageIds.map(buildDeterministicTurnId),
    ]);
    const sender =
      await getLatestAgentInvocationForConversation(conversationId);
    if (
      sender &&
      (
        await readParentInboundMessageIds(
          sender.parentConversationId,
          undefined,
        )
      ).some((messageId) => {
        const turnId = parseTurnReplyMessageId(messageId);
        return (
          turnId !== undefined &&
          turnIds.has(turnId) &&
          isAgentReplyMessageId(messageId, sender.invocationId)
        );
      })
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
  options: { queue: ConversationWorkQueue; state?: StateAdapter },
): Promise<ConversationWorkerResult | undefined> {
  const messages = context.attempt.messages;
  const latest = await getLatestAgentInvocationForConversation(
    context.conversationId,
  );
  if (messages.length === 0 || !latest) {
    return undefined;
  }
  const stoppedAtMs = await getConversationStoppedAtMs(context.conversationId);
  const routes = await Promise.all(
    messages.map((message) => routeChildInput(message, latest, stoppedAtMs)),
  );
  if (!routes.includes("agent invocation")) {
    return undefined;
  }
  const inputs = messages.map(childAgentInput);
  const isAgentInput = inputs.every((input) => input !== undefined);
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
    if (routes[index] === "dropped") {
      continue;
    }
    const input = inputs[index]!;
    const source = await getChildAgentInputInvocation(message, input);
    const invocation = await createAgentInvocationFromLatest({
      input: message.input.text.trim(),
      invocationId:
        input.kind === "result"
          ? getAgentInvocationIdForResult(source.invocationId)
          : getAgentInvocationIdForMessage(message.inboundMessageId),
      latest,
      // A result continues the work of the Turn that spawned its child
      // agent, with that Turn's Actor and grants, such as a timer Turn that
      // ran on the Conversation loop after `latest` ended.
      ...(input.kind === "result"
        ? {
            runAs: {
              actor: source.actor,
              credentialContext: source.credentialContext,
            },
          }
        : undefined),
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
    maxAgentDepth?: number;
    queue: ConversationWorkQueue;
    runTurn: (
      context: ConversationWorkerContext,
      work: MailboxTurnWork,
    ) => Promise<ConversationWorkerResult>;
    state?: StateAdapter;
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
    return await options.runTurn(context, kept);
  };
}

/**
 * Run each agent invocation result or message as the Actor that triggered the
 * child, user or system, with its grants. This is on purpose: the result
 * continues that Actor's work. The Actor comes from SQL, not from mailbox
 * metadata, so the parent Turn has the same authority it had at spawn time.
 * Input that a child's Turn with another Actor sent runs as the Event system
 * Actor, so it never gets more authority than that Turn. A result that a stop
 * skipped is dropped. Returns undefined when no input is left.
 */
export async function withAgentInvocationResultActors(
  work: MailboxTurnWork,
): Promise<MailboxTurnWork | undefined> {
  if (work.kind !== "mailbox") {
    return work;
  }
  const conversationId = work.batch[0]?.message.conversationId;
  const [latest, stoppedAtMs] = conversationId
    ? await Promise.all([
        getLatestAgentInvocationForConversation(conversationId),
        getConversationStoppedAtMs(conversationId),
      ])
    : [undefined, undefined];
  const batch = await Promise.all(
    work.batch.map(async (entry) => {
      const input = childAgentInput(entry.message);
      if (!input) {
        return entry;
      }
      if (
        (await routeChildInput(entry.message, latest, stoppedAtMs)) ===
        "dropped"
      ) {
        return undefined;
      }
      const invocation = await getChildAgentInputInvocation(
        entry.message,
        input,
      );
      if (entry.message.input.authorId !== resultAuthorId(invocation.actor)) {
        return { ...entry, actor: EVENT_SYSTEM_ACTOR };
      }
      // Only a result continues the work of the Turn that spawned the child,
      // so only a result keeps that Turn's grants, such as a timer owner's. A
      // reply or message runs as the Actor only.
      return input.kind === "result" && invocation.credentialContext
        ? {
            ...entry,
            actor: invocation.actor,
            credentialContext: invocation.credentialContext,
          }
        : { ...entry, actor: invocation.actor };
    }),
  );
  const kept = batch.filter((entry) => entry !== undefined);
  return kept.length > 0 ? { kind: "mailbox", batch: kept } : undefined;
}
