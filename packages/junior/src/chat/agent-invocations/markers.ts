/**
 * Dashboard records for agent invocations. The parent Conversation gets one
 * `subagent_started` and one `subagent_ended` event for each agent invocation.
 * The child Conversation gets `message` events for its input and its result,
 * because a child has no Location that records visible messages.
 */
import type { TurnReference } from "@/chat/conversations/history";
import { getConversationEventStore } from "@/chat/db";
import { getAgentInvocationMessageId } from "./store";
import type { AgentInvocation, TerminalAgentInvocation } from "./types";

// The dashboard labels each child row with this kind.
const SUBAGENT_KIND = "agent";

function subagentStartedKey(invocationId: string): string {
  return `subagent_started:${invocationId}`;
}

/**
 * Record in the parent Conversation that one agent invocation started, and
 * record its input as a user message in the child Conversation. The dashboard
 * pairs the parent event with `subagent_ended` to show the child and its
 * status. It must be written before the child mailbox append, so the child
 * cannot end first. `causingTurn` is the Turn that caused the agent
 * invocation. The child Turn takes its task Actor.
 */
export async function recordSubagentStarted(
  invocation: AgentInvocation,
  causingTurn?: TurnReference,
): Promise<void> {
  const eventStore = getConversationEventStore();
  // The mailbox input has the same id, so the child Turn links to it.
  const messageId = getAgentInvocationMessageId(invocation.invocationId);
  await eventStore.append(invocation.childConversationId, [
    {
      idempotencyKey: `message:${messageId}`,
      data: {
        type: "message",
        messageId,
        role: "user",
        text: invocation.input,
      },
      createdAtMs: invocation.createdAtMs,
    },
  ]);
  await eventStore.append(invocation.parentConversationId, [
    {
      idempotencyKey: subagentStartedKey(invocation.invocationId),
      data: {
        type: "subagent_started",
        subagentInvocationId: invocation.invocationId,
        subagentKind: SUBAGENT_KIND,
        childConversationId: invocation.childConversationId,
        ...(invocation.agentName
          ? { agentName: invocation.agentName }
          : undefined),
        // Only a `spawnAgent` or `messageAgent` call has a task. An agent
        // invocation that receives a nested result or message has another
        // child's output as its input.
        ...(invocation.parentToolCallId
          ? {
              parentToolCallId: invocation.parentToolCallId,
              task: invocation.input,
            }
          : undefined),
        ...(invocation.title ? { title: invocation.title } : undefined),
        ...(invocation.reasoningLevel
          ? { reasoningLevel: invocation.reasoningLevel }
          : undefined),
        ...(causingTurn ? { causingTurn } : undefined),
      },
      createdAtMs: invocation.createdAtMs,
    },
  ]);
}

/**
 * Read the Turn that caused one agent invocation from its `subagent_started`
 * event. It is undefined when the event names no causing Turn.
 */
export async function loadCausingTurn(
  invocation: Pick<AgentInvocation, "invocationId" | "parentConversationId">,
): Promise<TurnReference | undefined> {
  const event = await getConversationEventStore().loadByIdempotencyKey(
    invocation.parentConversationId,
    subagentStartedKey(invocation.invocationId),
  );
  return event?.data.type === "subagent_started" &&
    event.data.subagentInvocationId === invocation.invocationId
    ? event.data.causingTurn
    : undefined;
}

const SUBAGENT_OUTCOMES = {
  blocked: "blocked",
  completed: "success",
  failed: "error",
  stopped: "aborted",
} as const satisfies Record<TerminalAgentInvocation["status"], string>;

/**
 * Record in the parent Conversation how one agent invocation ended, and record
 * a completed result as an assistant message in the child Conversation. The
 * heartbeat result repair also calls this, because the child work can be
 * acknowledged before the worker reports the result.
 */
export async function recordSubagentEnded(
  invocation: TerminalAgentInvocation,
): Promise<void> {
  const eventStore = getConversationEventStore();
  // Write the parent outcome first. The child message only feeds the child
  // transcript, so it must not hold back how the parent sees the child end.
  await eventStore.append(invocation.parentConversationId, [
    {
      idempotencyKey: `subagent_ended:${invocation.invocationId}`,
      data: {
        type: "subagent_ended",
        subagentInvocationId: invocation.invocationId,
        outcome: SUBAGENT_OUTCOMES[invocation.status],
      },
      createdAtMs: invocation.terminalAtMs,
    },
  ]);
  const result =
    invocation.status === "completed" ? invocation.result.trim() : "";
  if (!result) return;
  const messageId = `agent-invocation:${invocation.invocationId}:reply`;
  await eventStore.append(invocation.childConversationId, [
    {
      idempotencyKey: `message:${messageId}`,
      data: {
        type: "message",
        messageId,
        role: "assistant",
        text: result,
      },
      createdAtMs: invocation.terminalAtMs,
    },
  ]);
}
