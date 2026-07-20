/** Storage prefix shared by turn-session records and their indexes. */
export const AGENT_TURN_SESSION_PREFIX = "junior:agent_turn_session";

/** Return the durable key for one resumable turn-session record. */
export function agentTurnSessionKey(
  conversationId: string,
  sessionId: string,
): string {
  return `${AGENT_TURN_SESSION_PREFIX}:${conversationId}:${sessionId}`;
}

/** Return the index key for every turn session owned by one conversation. */
export function agentTurnSessionConversationIndexKey(
  conversationId: string,
): string {
  return `${AGENT_TURN_SESSION_PREFIX}:conversation:${conversationId}:index`;
}
