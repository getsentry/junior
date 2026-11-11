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

const REPLY_MESSAGE_PREFIX = "agent-reply:";

/** Return the parent mailbox identity of one child agent `reply` call. */
export function getAgentReplyMessageId(
  invocationId: string,
  toolCallId: string,
): string {
  return `${REPLY_MESSAGE_PREFIX}${invocationId}:${toolCallId}`;
}

/**
 * Return the key of the `reply` of one Turn on a child's Conversation loop.
 * It starts with the Turn id, so the parent can tell that the Turn replied.
 */
export function getTurnReplyKey(turnId: string, toolCallId: string): string {
  return `${turnId}:${toolCallId}`;
}

// Agent invocation ids come from `stableId`.
const REPLY_MESSAGE_ID = /^agent-reply:(agent-invocation:[0-9a-f]{32}):/;

/** Read the agent invocation identity from one parent `reply` mailbox identity. */
export function parseAgentReplyMessageId(
  messageId: string,
): string | undefined {
  return REPLY_MESSAGE_ID.exec(messageId)?.[1];
}

// Turn ids come from `buildDeterministicTurnId` and have no `:`.
const TURN_REPLY_MESSAGE_ID =
  /^agent-reply:agent-invocation:[0-9a-f]{32}:(turn_[A-Za-z0-9_-]+)(?::|$)/;

/**
 * Read the Turn id from one parent mailbox identity that a Turn on a child's
 * Conversation loop sent. A `reply` of an agent invocation has none.
 */
export function parseTurnReplyMessageId(messageId: string): string | undefined {
  return TURN_REPLY_MESSAGE_ID.exec(messageId)?.[1];
}

/** Return whether one parent mailbox identity is a `reply` of an agent invocation. */
export function isAgentReplyMessageId(
  messageId: string,
  invocationId: string,
): boolean {
  return messageId.startsWith(`${REPLY_MESSAGE_PREFIX}${invocationId}:`);
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
