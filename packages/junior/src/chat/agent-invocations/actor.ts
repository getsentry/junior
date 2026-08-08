/**
 * Identity helpers for agent-invocation result turns.
 *
 * Parent-result mailbox messages are synthetic (not human-authored). Message
 * markers identify the kind; execution authority is restored from the durable
 * agent invocation (parent actor + credentialContext), not a synthetic system
 * principal. Resource events keep a system principal because they are external
 * watches without a parent run binding.
 */
import type { Actor } from "@/chat/actor";
import {
  credentialContextForActor,
  type CredentialContext,
} from "@/chat/credentials/context";
import { getAgentInvocation } from "@/chat/agent-invocations/store";

/** Synthetic Slack author id stamped on agent-invocation result messages. */
export const AGENT_INVOCATION_RESULT_SLACK_AUTHOR_ID = "UJRNAGENT";

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

/** Read the durable agent-invocation id stamped on a synthetic result message. */
export function getAgentInvocationIdFromSlackMessage(message: {
  raw?: unknown;
}): string | undefined {
  const raw =
    message.raw && typeof message.raw === "object"
      ? (message.raw as Record<string, unknown>)
      : undefined;
  return typeof raw?.agent_invocation_id === "string" &&
    raw.agent_invocation_id.trim().length > 0
    ? raw.agent_invocation_id
    : undefined;
}

/** Parse the durable parent-result message id back to an invocation id. */
export function getAgentInvocationIdFromParentResultMessageId(
  messageId: string | undefined,
): string | undefined {
  if (!messageId?.startsWith("agent-invocation:") || !messageId.endsWith(":result")) {
    return undefined;
  }
  const invocationId = messageId.slice(
    "agent-invocation:".length,
    -":result".length,
  );
  return invocationId.trim().length > 0 ? invocationId : undefined;
}

/** Restore parent run authority for one terminal agent-invocation result. */
export async function resolveAgentInvocationResultAuthority(args: {
  messageId?: string;
  raw?: unknown;
}): Promise<{ actor: Actor; credentialContext: CredentialContext } | undefined> {
  const invocationId =
    getAgentInvocationIdFromSlackMessage(args) ??
    getAgentInvocationIdFromParentResultMessageId(args.messageId);
  if (!invocationId) {
    return undefined;
  }
  const invocation = await getAgentInvocation(invocationId);
  if (!invocation) {
    return undefined;
  }
  return {
    actor: invocation.actor,
    credentialContext:
      invocation.credentialContext ??
      credentialContextForActor(invocation.actor),
  };
}
