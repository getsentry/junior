/** Redis namespace for the current turn cursor format. */
export const TURN_CURSOR_PREFIX = "junior:turn_cursor:v2";

/** Return the Redis key for one turn cursor. */
export function turnCursorKey(conversationId: string, turnId: string): string {
  return `${TURN_CURSOR_PREFIX}:${conversationId}:${turnId}`;
}

/** Return the Redis recovery-index key for one conversation. */
export function turnCursorIndexKey(conversationId: string): string {
  return `${TURN_CURSOR_PREFIX}:conversation:${conversationId}:index`;
}
