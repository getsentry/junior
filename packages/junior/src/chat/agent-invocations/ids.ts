import { createHash } from "node:crypto";

const CREATE_LOCK_PREFIX = "junior:agent_invocation:create";

/**
 * Return the SQL lock that one parent Conversation takes to start, message,
 * or stop its child agents.
 */
export function getChildAgentLockName(parentConversationId: string): string {
  return `${CREATE_LOCK_PREFIX}:${parentConversationId}`;
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}:${digest}`;
}

/** Return the stable identity for one retry-safe delegated task. */
export function getAgentInvocationId(
  parentConversationId: string,
  idempotencyKey: string,
): string {
  return stableId("agent-invocation", parentConversationId, idempotencyKey);
}

/** Return the stable child identity for one invocation without a named binding. */
export function getUnnamedAgentConversationId(invocationId: string): string {
  return stableId("agent", invocationId);
}

/** Return the stable child identity for one named binding. */
export function getNamedAgentConversationId(
  parentConversationId: string,
  name: string,
): string {
  return stableId("agent", parentConversationId, name);
}

/**
 * Return the stable identity of the agent invocation that gives one child
 * agent result to the child Conversation that started that child agent.
 */
export function getAgentInvocationIdForResult(
  resultInvocationId: string,
): string {
  return stableId("agent-invocation", "result", resultInvocationId);
}

/**
 * Return the stable identity of the agent invocation that gives one message
 * from a child agent to the child Conversation that started that child agent.
 */
export function getAgentInvocationIdForMessage(messageId: string): string {
  return stableId("agent-invocation", "message", messageId);
}

/**
 * Return the stable identity of the agent invocation that gives one batch of
 * watch events to a child Conversation. The first message of the batch names
 * it.
 */
export function getAgentInvocationIdForEvents(messageId: string): string {
  return stableId("agent-invocation", "events", messageId);
}

/** Return the stable turn identity advanced by one agent invocation. */
export function getAgentInvocationTurnId(invocationId: string): string {
  return `agent-invocation:${invocationId}`;
}

/** Return the stable mailbox identity for one agent invocation. */
export function getAgentInvocationMessageId(invocationId: string): string {
  return `agent-invocation:${invocationId}:input`;
}

const RESULT_MESSAGE_PREFIX = "agent-invocation:";
const RESULT_MESSAGE_SUFFIX = ":result";

/** Return the stable parent mailbox identity for one terminal result. */
export function getAgentInvocationResultMessageId(
  invocationId: string,
): string {
  return `${RESULT_MESSAGE_PREFIX}${invocationId}${RESULT_MESSAGE_SUFFIX}`;
}

/** Read the invocation identity from one parent result mailbox identity. */
export function parseAgentInvocationResultMessageId(
  messageId: string,
): string | undefined {
  if (
    !messageId.startsWith(RESULT_MESSAGE_PREFIX) ||
    !messageId.endsWith(RESULT_MESSAGE_SUFFIX)
  ) {
    return undefined;
  }
  const invocationId = messageId.slice(
    RESULT_MESSAGE_PREFIX.length,
    -RESULT_MESSAGE_SUFFIX.length,
  );
  return invocationId || undefined;
}
