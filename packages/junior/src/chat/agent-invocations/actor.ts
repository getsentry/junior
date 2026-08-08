/**
 * Execution identity for agent-invocation result turns.
 *
 * Parent-result mailbox messages are synthetic (not human-authored). They run
 * as this system principal for credentials and attribution. Live delivery stamps
 * the author id / raw marker; resume rebuilds the same system actor from those
 * durable markers.
 */
import type { Actor } from "@/chat/actor";

/** Synthetic Slack author id stamped on agent-invocation result messages. */
export const AGENT_INVOCATION_RESULT_SLACK_AUTHOR_ID = "UJRNAGENT";

/** System execution actor for every agent-invocation result turn. */
export const AGENT_INVOCATION_RESULT_SYSTEM_ACTOR = {
  platform: "system",
  name: "agent-invocation-result",
} as const satisfies Actor;

/** Whether a durable conversation message is an agent-invocation result input. */
export function isAgentInvocationResultConversationMessage(message: {
  author?: { userId?: string };
  meta?: { eventType?: string };
}): boolean {
  return (
    message.meta?.eventType === "agent_invocation_result" ||
    message.author?.userId === AGENT_INVOCATION_RESULT_SLACK_AUTHOR_ID
  );
}

/**
 * Whether a Slack Message payload is a synthetic agent-invocation result.
 * Checks the raw `event_type` marker stamped at mailbox serialization.
 */
export function isAgentInvocationResultSlackMessage(message: {
  raw?: unknown;
}): boolean {
  const raw =
    message.raw && typeof message.raw === "object"
      ? (message.raw as Record<string, unknown>)
      : undefined;
  return raw?.event_type === "agent_invocation_result";
}
