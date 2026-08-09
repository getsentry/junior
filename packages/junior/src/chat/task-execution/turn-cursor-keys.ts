/** Redis namespace for the current turn cursor format. */
const TURN_CURSOR_PREFIX = "junior:turn_cursor:v2";

/** Return the Redis key for one turn cursor. */
export function turnCursorKey(conversationId: string, turnId: string): string {
  return `${TURN_CURSOR_PREFIX}:${conversationId}:${turnId}`;
}

/** Return the Redis index key for one conversation's turns. */
export function turnCursorIndexKey(conversationId: string): string {
  return `${TURN_CURSOR_PREFIX}:conversation:${conversationId}:index`;
}

/** Return the lock key that serializes writes to one turn cursor. */
export function turnCursorMutationKey(
  conversationId: string,
  turnId: string,
): string {
  return `${TURN_CURSOR_PREFIX}:mutation:${conversationId}:${turnId}`;
}
