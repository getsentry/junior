/**
 * Dashboard records for agent invocations. The parent Conversation gets one
 * `subagent_started` and one `subagent_ended` event for each agent invocation.
 * The child Conversation gets `message` events for its input and its result,
 * because a child posts nothing to its Location.
 */
import { getConversationEventStore } from "@/chat/db";
import type { ConversationMessageMeta } from "@/chat/state/conversation";
import { getAgentInvocationMessageId } from "./ids";
import { reportTexts } from "./report";
import type { AgentInvocation, TerminalAgentInvocation } from "./types";

// The dashboard labels each child row with this kind.
const SUBAGENT_KIND = "agent";

/**
 * Record in the parent Conversation that one agent invocation started, and
 * record its input as a user message in the child Conversation. The dashboard
 * pairs the parent event with `subagent_ended` to show the child and its
 * status. It must be written before the child mailbox append, so the child
 * cannot end first. An agent wrote the input, not a person, so the message
 * names its agent invocation instead of an author. Input from Events, such as
 * the child's own Watch Events, passes their Event fields, so the dashboard
 * shows it as an Event, as on a root.
 */
export async function recordSubagentStarted(
  invocation: AgentInvocation,
  eventMeta?: ConversationMessageMeta,
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
        meta: { ...eventMeta, agentInvocationId: invocation.invocationId },
      },
      createdAtMs: invocation.createdAtMs,
    },
  ]);
  await eventStore.append(invocation.parentConversationId, [
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
 * Record in the parent Conversation how one agent invocation ended, and record
 * the reports that the child sent as an assistant message in the child
 * Conversation. A runtime note, such as "no report was sent", is not the
 * child's text, so it is not recorded there.
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
    invocation.status === "completed"
      ? reportTexts(invocation.reportLog).join("\n\n")
      : "";
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
