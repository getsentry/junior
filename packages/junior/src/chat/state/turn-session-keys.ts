/** Storage prefix for resumable turn-session state. */
export const AGENT_TURN_SESSION_PREFIX = "junior:agent_turn_session";

/** Return the durable key for one resumable turn-session record. */
export function agentTurnSessionKey(
  conversationId: string,
  sessionId: string,
): string {
  return `${AGENT_TURN_SESSION_PREFIX}:${conversationId}:${sessionId}`;
}

/** Return the recovery index key for turn sessions in one conversation. */
export function agentTurnSessionConversationIndexKey(
  conversationId: string,
): string {
  return `${AGENT_TURN_SESSION_PREFIX}:conversation:${conversationId}:index`;
}
