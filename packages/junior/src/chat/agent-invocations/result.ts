import type { StateAdapter } from "chat";
import type { Actor } from "@/chat/actor";
import {
  EVENT_WAIT_MS,
  isEventMailboxMetadata,
  type EventMailboxMetadata,
} from "@/chat/events/notification";
import { renderTaskInput } from "@/chat/task-input";
import type { MailboxTurnWork } from "@/chat/task-execution/mailbox-turn";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  appendAndEnqueueInboundMessage,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import {
  createAgentInvocationForResult,
  getAgentInvocation,
  getAgentInvocationResultMessageId,
  getLatestAgentInvocationForConversation,
  isTerminalAgentInvocation,
  markAgentInvocationParentMailboxAppended,
} from "./store";
import type { TerminalAgentInvocation } from "./types";
import { enqueueAgentInvocation } from "./work";

const AGENT_INVOCATION_EVENT_NAMESPACE = "junior";
// TODO(dcramer): Add an `agent_invocation.needs_input` Event type when a child
// can pause for input or auth instead of failing (#881).
const AGENT_INVOCATION_EVENT_TYPE_PREFIX = "agent_invocation.";
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
 * Error messages can contain text from tools or providers, so only the status
 * is trusted. The result or error goes in external text.
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
 * Build the parent Inbound message for one terminal agent invocation. The
 * child result is model output, so the parent gets it as information, not
 * instructions. Verified details leave out the task. The input of an agent
 * invocation that receives a result holds another child's output, and the
 * parent's own `spawnAgent` call already has the task.
 */
function buildResultInboundMessage(
  invocation: TerminalAgentInvocation,
  nowMs: number,
): InboundMessage {
  const agent = invocation.agentName
    ? `Child agent "${invocation.agentName}"`
    : "Child agent";
  const summary = trustedSummary(invocation, agent);
  const metadata: EventMailboxMetadata = {
    kind: "event",
    event: {
      eventKey: invocation.invocationId,
      eventType: `${AGENT_INVOCATION_EVENT_TYPE_PREFIX}${invocation.status}`,
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
      metadata,
      text: renderTaskInput({
        about: agent,
        instructions:
          "A child agent that you started has ended. Its status tells how it ended. Use its result to continue the work in this conversation. Do not repeat work that the child agent already did.",
        trustedSummary: summary,
        verifiedDetails: {
          conversation_id: invocation.childConversationId,
          ...(invocation.agentName
            ? { agent_name: invocation.agentName }
            : undefined),
          status: invocation.status,
        },
        externalText:
          invocation.status === "completed"
            ? invocation.result
            : invocation.errorMessage,
        externalTextMaxLength: AGENT_INVOCATION_RESULT_MAX_LENGTH,
      }),
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
  await appendAndEnqueueInboundMessage({
    message: buildResultInboundMessage(invocation, nowMs),
    queue: options.queue,
    queueDelayMs: EVENT_WAIT_MS,
    state: options.state,
  });
  await markAgentInvocationParentMailboxAppended(
    invocation.invocationId,
    nowMs,
  );
}

function resultInvocationId(message: InboundMessage): string | undefined {
  const metadata = message.input.metadata;
  return isEventMailboxMetadata(metadata) &&
    metadata.event.namespace === AGENT_INVOCATION_EVENT_NAMESPACE &&
    metadata.event.eventType.startsWith(AGENT_INVOCATION_EVENT_TYPE_PREFIX)
    ? metadata.event.identifier
    : undefined;
}

/** Read one result message's agent invocation and check its parent. */
async function getResultInvocation(
  message: InboundMessage,
  invocationId: string,
): Promise<TerminalAgentInvocation> {
  const invocation = await getAgentInvocation(invocationId);
  if (
    !invocation ||
    !isTerminalAgentInvocation(invocation) ||
    invocation.parentConversationId !== message.conversationId
  ) {
    throw new Error(
      `Agent invocation result ${invocationId} does not belong to ${message.conversationId}`,
    );
  }
  return invocation;
}

/**
 * Give agent invocation results that reach a child Conversation to that
 * child. A child Conversation has no Location, so it cannot run an Event
 * Turn. Each result starts a new agent invocation on the child instead, and
 * that invocation reports to the child's parent. Returns undefined for work
 * that is not a result for a child Conversation.
 */
export async function startAgentInvocationsForChildResults(
  context: ConversationWorkerContext,
  options: { queue: ConversationWorkQueue; state?: StateAdapter },
): Promise<ConversationWorkerResult | undefined> {
  const messages = context.attempt.messages;
  const invocationIds = messages.map(resultInvocationId);
  if (messages.length === 0 || invocationIds.some((id) => !id)) {
    return undefined;
  }
  const latest = await getLatestAgentInvocationForConversation(
    context.conversationId,
  );
  if (!latest) {
    return undefined;
  }
  // A stopped child takes no new work, even from a result sent before the
  // stop.
  if (latest.status === "stopped") {
    await context.attempt.ack();
    return { status: "completed" };
  }
  for (const [index, message] of messages.entries()) {
    const result = await getResultInvocation(message, invocationIds[index]!);
    // The child was stopped after this result was sent.
    if (result.parentMailboxStatus === "skipped") {
      continue;
    }
    const invocation = await createAgentInvocationForResult({
      input: message.input.text.trim(),
      latest,
      resultInvocationId: result.invocationId,
    });
    await enqueueAgentInvocation(invocation, options);
  }
  await context.attempt.ack();
  return { status: "completed" };
}

/**
 * Run each agent invocation result as the Actor that triggered the child, user
 * or system. This is on purpose: the result continues that Actor's work. The
 * Actor comes from SQL, not from mailbox metadata, so the parent Turn has the
 * same authority it had at spawn time.
 *
 * TODO(dcramer): Pass the delegated credential subject of a system Actor, such
 * as a timer watch Turn, when system Turns can spawn children that need it.
 */
export async function withAgentInvocationResultActors(
  work: MailboxTurnWork,
): Promise<MailboxTurnWork> {
  if (work.kind !== "mailbox") {
    return work;
  }
  const batch = await Promise.all(
    work.batch.map(async (entry) => {
      const invocationId = resultInvocationId(entry.message);
      if (!invocationId) {
        return entry;
      }
      const invocation = await getResultInvocation(entry.message, invocationId);
      return { ...entry, actor: invocation.actor };
    }),
  );
  return { kind: "mailbox", batch };
}
