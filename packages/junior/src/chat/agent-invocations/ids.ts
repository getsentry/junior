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

// The ids below keep the values that earlier releases wrote, so a retry of
// a spawn or message from before a deploy finds its child and its message.
// No reader takes meaning from them.
function taskKey(parentConversationId: string, idempotencyKey: string) {
  return stableId("agent-invocation", parentConversationId, idempotencyKey);
}

/**
 * Return the stable child identity for one spawn, with a name or without.
 * The spawn's idempotency key names it, so a replay finds the same child.
 */
export function getSpawnedChildConversationId(
  parentConversationId: string,
  idempotencyKey: string,
): string {
  return stableId("agent", taskKey(parentConversationId, idempotencyKey));
}

/** Return the mailbox identity of one parent message. */
export function getParentMessageId(
  parentConversationId: string,
  idempotencyKey: string,
): string {
  return `agent-invocation:${taskKey(parentConversationId, idempotencyKey)}:input`;
}

const REPLY_MESSAGE_PREFIX = "agent-reply:";

/** Return the parent mailbox identity of one child agent Turn's result. */
export function getAgentReplyMessageId(
  childConversationId: string,
  messageKey: string,
): string {
  return `${REPLY_MESSAGE_PREFIX}${childConversationId}:${messageKey}`;
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
