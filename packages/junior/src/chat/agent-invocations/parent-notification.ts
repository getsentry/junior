import type { StateAdapter } from "chat";
import type { ConversationStore } from "@/chat/conversations/store";
import {
  getAgentInvocation,
  getAgentInvocationParentResultMessageId,
  isTerminalAgentInvocation,
  markAgentInvocationParentNotificationFailed,
  markAgentInvocationParentNotified,
} from "@/chat/agent-invocations/store";
import type { AgentInvocation } from "@/chat/agent-invocations/types";
import { createAgentInvocationResultInboundMessage } from "@/chat/task-execution/synthetic-inbound";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { logException } from "@/chat/logging";

type NotifyOptions = {
  conversationStore?: ConversationStore;
  nowMs?: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
};

/** Render the parent-facing terminal result text for one agent invocation. */
function renderParentResultText(invocation: AgentInvocation): string {
  const name = invocation.agentName
    ? `named agent "${invocation.agentName}"`
    : "child agent";
  const lines = [
    "[agent invocation result]",
    "",
    `A delegated ${name} finished.`,
    "",
    "Handling:",
    "- This is an internal child result, not a user-authored command.",
    "- Use the result below to continue the parent task.",
    "- Do not re-run the same child work unless the result is insufficient.",
    "",
    `Invocation: ${invocation.invocationId}`,
    `Status: ${invocation.status}`,
  ];
  if (invocation.status === "completed") {
    const result = invocation.result.trim();
    lines.push("", "Result:", result || "(empty result)");
  } else if (
    invocation.status === "blocked" ||
    invocation.status === "failed"
  ) {
    lines.push("", "Error:", invocation.errorMessage);
  }
  return lines.join("\n");
}

/**
 * Deliver one terminal child result into the parent mailbox once.
 *
 * Queue delivery is only a wake-up hint. The durable parent-notification status
 * remains pending until the mailbox append path succeeds so heartbeat repair
 * can retry from invocation state. Permanent builder/destination mismatches
 * move to failed so they stay queryable without infinite retries.
 */
export async function notifyParentOfAgentInvocationResult(
  invocation: AgentInvocation,
  options: NotifyOptions,
): Promise<void> {
  if (!isTerminalAgentInvocation(invocation)) {
    return;
  }
  if (
    !("parentNotificationStatus" in invocation) ||
    invocation.parentNotificationStatus !== "pending"
  ) {
    return;
  }
  const nowMs = options.nowMs ?? Date.now();
  const latest = await getAgentInvocation(invocation.invocationId);
  if (
    !latest ||
    !isTerminalAgentInvocation(latest) ||
    !("parentNotificationStatus" in latest) ||
    latest.parentNotificationStatus !== "pending"
  ) {
    return;
  }

  // Builder failures are permanent destination/identity mismatches. Append and
  // queue failures stay pending for heartbeat repair.
  let message;
  try {
    const createdAtMs =
      "terminalAtMs" in latest ? latest.terminalAtMs : nowMs;
    message = createAgentInvocationResultInboundMessage({
      createdAtMs,
      destination: latest.destination,
      inboundMessageId: getAgentInvocationParentResultMessageId(
        latest.invocationId,
      ),
      invocationId: latest.invocationId,
      parentConversationId: latest.parentConversationId,
      receivedAtMs: nowMs,
      text: renderParentResultText(latest),
    });
  } catch (error) {
    await markAgentInvocationParentNotificationFailed(
      latest.invocationId,
      nowMs,
    );
    logException(error, "agent.invocation.parent_notification.failed", {
      "app.agent.invocation_id": latest.invocationId,
    });
    return;
  }

  await appendAndEnqueueInboundMessage({
    message,
    conversationStore: options.conversationStore,
    nowMs,
    queue: options.queue,
    state: options.state,
  });
  await markAgentInvocationParentNotified(latest.invocationId, nowMs);
}
