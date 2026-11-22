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

/**
 * Return the stable child identity for one spawn that writes no Agent
 * invocation, with a name or without. The spawn's idempotency key names it,
 * so a replay finds the same child. It equals the id of an unnamed child
 * with an Agent invocation for the same key.
 */
export function getSpawnedChildConversationId(
  parentConversationId: string,
  idempotencyKey: string,
): string {
  return getUnnamedAgentConversationId(
    getAgentInvocationId(parentConversationId, idempotencyKey),
  );
}

/**
 * Return the stable child identity for one named binding.
 *
 * TODO(dcramer): Delete with Agent bindings. A spawn with no Agent
 * invocation names its child with `getSpawnedChildConversationId`
 * (#3060 step 7).
 */
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

/**
 * Return the parent mailbox identity of one child agent `reply` call.
 * `senderId` is the Agent invocation that sent it, or the child Conversation
 * when no Agent invocation names the child.
 */
export function getAgentReplyMessageId(
  senderId: string,
  toolCallId: string,
): string {
  return `${REPLY_MESSAGE_PREFIX}${senderId}:${toolCallId}`;
}

/**
 * Return the key of the `reply` of one Turn on a child's Conversation loop.
 * Readers take the sender from the message's sender fields, not this key.
 */
export function getTurnReplyKey(turnId: string, toolCallId: string): string {
  return `${turnId}:${toolCallId}`;
}

// The Turn id of the `stopped` result that a person's stop of a child agent
// sends. No Turn has it, so readers can tell this result from a Turn's reply.
const PERSON_STOP_TURN_PREFIX = "stopped:";

/** Return the Turn id that keys the `stopped` result of one person's stop. */
export function getPersonStopTurnId(stoppedAtMs: number): string {
  return `${PERSON_STOP_TURN_PREFIX}${stoppedAtMs}`;
}

/** Return whether a sender Turn id names a person's stop, not a Turn. */
export function isPersonStopTurnId(turnId: string): boolean {
  return turnId.startsWith(PERSON_STOP_TURN_PREFIX);
}

/** Return the stable parent mailbox identity for one terminal result. */
export function getAgentInvocationResultMessageId(
  invocationId: string,
): string {
  return `agent-invocation:${invocationId}:result`;
}
