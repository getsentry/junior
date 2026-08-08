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
import {
  appendAndEnqueueInboundMessage,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { logException } from "@/chat/logging";

type NotifyOptions = {
  conversationStore?: ConversationStore;
  nowMs?: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
};

/** Permanent parent-delivery failures that should not keep retrying. */
export class PermanentAgentInvocationParentNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentAgentInvocationParentNotificationError";
  }
}

/** Render the parent-facing terminal result text for one agent invocation. */
export function renderAgentInvocationParentResultText(
  invocation: AgentInvocation,
): string {
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
 * Build the stable parent mailbox entry for one terminal agent invocation.
 *
 * Shape matches other internal wakes (dispatch / child invocation): kind +
 * durable reference id + rendered text. Slack parents also carry the synthetic
 * envelope resource events use so the shared Slack worker can restore the turn.
 */
export function buildAgentInvocationParentResultInboundMessage(
  invocation: AgentInvocation,
  nowMs = Date.now(),
): InboundMessage {
  if (!isTerminalAgentInvocation(invocation)) {
    throw new PermanentAgentInvocationParentNotificationError(
      `Agent invocation ${invocation.invocationId} is not terminal`,
    );
  }
  const text = renderAgentInvocationParentResultText(invocation);
  const createdAtMs =
    "terminalAtMs" in invocation ? invocation.terminalAtMs : nowMs;
  const inboundMessageId = getAgentInvocationParentResultMessageId(
    invocation.invocationId,
  );
  try {
    return createAgentInvocationResultInboundMessage({
      createdAtMs,
      destination: invocation.destination,
      inboundMessageId,
      invocationId: invocation.invocationId,
      parentConversationId: invocation.parentConversationId,
      receivedAtMs: nowMs,
      text,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Agent invocation parent delivery could not build mailbox input";
    throw new PermanentAgentInvocationParentNotificationError(message);
  }
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
  try {
    await appendAndEnqueueInboundMessage({
      message: buildAgentInvocationParentResultInboundMessage(latest, nowMs),
      conversationStore: options.conversationStore,
      nowMs,
      queue: options.queue,
      state: options.state,
    });
    await markAgentInvocationParentNotified(latest.invocationId, nowMs);
  } catch (error) {
    if (error instanceof PermanentAgentInvocationParentNotificationError) {
      await markAgentInvocationParentNotificationFailed(
        latest.invocationId,
        nowMs,
      );
      logException(error, "agent.invocation.parent_notification.failed", {
        "app.agent.invocation_id": latest.invocationId,
      });
      return;
    }
    throw error;
  }
}
