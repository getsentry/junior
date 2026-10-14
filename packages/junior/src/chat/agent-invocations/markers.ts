/**
 * Dashboard markers for agent invocations. The parent Conversation gets one
 * `subagent_started` and one `subagent_ended` event for each agent invocation.
 */
import { getConversationEventStore } from "@/chat/db";
import type { AgentInvocation, TerminalAgentInvocation } from "./types";

// The dashboard labels each child row with this kind.
const SUBAGENT_KIND = "agent";

/**
 * Record in the parent Conversation that one agent invocation started. The
 * dashboard pairs this event with `subagent_ended` to show the child and its
 * status. It must be written before the child mailbox append, so the child
 * cannot end first.
 */
export async function recordSubagentStarted(
  invocation: AgentInvocation,
): Promise<void> {
  await getConversationEventStore().append(invocation.parentConversationId, [
    {
      idempotencyKey: `subagent_started:${invocation.invocationId}`,
      data: {
        type: "subagent_started",
        subagentInvocationId: invocation.invocationId,
        subagentKind: SUBAGENT_KIND,
        childConversationId: invocation.childConversationId,
        ...(invocation.agentName
          ? { agentName: invocation.agentName }
          : undefined),
        // Only a `spawnAgent` call has a task. An agent invocation that
        // receives a nested result has another child's output as its input.
        ...(invocation.parentToolCallId
          ? {
              parentToolCallId: invocation.parentToolCallId,
              task: invocation.input,
            }
          : undefined),
        ...(invocation.reasoningLevel
          ? { reasoningLevel: invocation.reasoningLevel }
          : undefined),
      },
      createdAtMs: invocation.createdAtMs,
    },
  ]);
}

const SUBAGENT_OUTCOMES = {
  blocked: "blocked",
  completed: "success",
  failed: "error",
  stopped: "aborted",
} as const satisfies Record<TerminalAgentInvocation["status"], string>;

/**
 * Record in the parent Conversation how one agent invocation ended. The
 * heartbeat result repair also calls this, because the child work can be
 * acknowledged before the worker reports the result.
 */
export async function recordSubagentEnded(
  invocation: TerminalAgentInvocation,
): Promise<void> {
  await getConversationEventStore().append(invocation.parentConversationId, [
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
}
