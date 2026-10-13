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
import {
  getAgentInvocation,
  getAgentInvocationResultMessageId,
  isTerminalAgentInvocation,
  markAgentInvocationParentMailboxAppended,
} from "./store";
import type { TerminalAgentInvocation } from "./types";

const AGENT_INVOCATION_EVENT_NAMESPACE = "junior";
// TODO(dcramer): Add an `agent_invocation.needs_input` Event type when a child
// can pause for input or auth instead of failing (#881).
const AGENT_INVOCATION_EVENT_TYPE_PREFIX = "agent_invocation.";
const AGENT_INVOCATION_RESULT_MAX_LENGTH = 12_000;
const AGENT_INVOCATION_TASK_MAX_LENGTH = 500;

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
  }
}

/**
 * Build the parent Inbound message for one terminal agent invocation. The
 * child result is model output, so the parent gets it as information, not
 * instructions.
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
          "A child agent that you started has stopped. Use its result to continue the work in this conversation. Do not repeat work that the child agent already did.",
        trustedSummary: summary,
        verifiedDetails: {
          conversation_id: invocation.childConversationId,
          ...(invocation.agentName
            ? { agent_name: invocation.agentName }
            : undefined),
          status: invocation.status,
          task: invocation.input.slice(0, AGENT_INVOCATION_TASK_MAX_LENGTH),
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
      const invocation = await getAgentInvocation(invocationId);
      if (
        !invocation ||
        !isTerminalAgentInvocation(invocation) ||
        invocation.parentConversationId !== entry.message.conversationId
      ) {
        throw new Error(
          `Agent invocation result ${invocationId} does not belong to ${entry.message.conversationId}`,
        );
      }
      return { ...entry, actor: invocation.actor };
    }),
  );
  return { kind: "mailbox", batch };
}
