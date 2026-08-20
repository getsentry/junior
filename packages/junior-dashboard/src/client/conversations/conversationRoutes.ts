/** Build the canonical workspace route for a conversation id. */
export function conversationPath(conversationId: string): string {
  return `/conversations/${encodeURIComponent(conversationId)}`;
}

/** Canonical route for the empty-state new-conversation compose surface. */
export const NEW_CONVERSATION_PATH = "/conversations/new";

/** True when the path is the create-compose destination. */
export function isNewConversationPath(pathname: string): boolean {
  return pathname === NEW_CONVERSATION_PATH;
}
