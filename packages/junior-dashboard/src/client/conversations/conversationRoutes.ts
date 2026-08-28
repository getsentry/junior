/** Build the canonical workspace route for a conversation id. */
export function conversationPath(conversationId: string): string {
  return `/conversations/${encodeURIComponent(conversationId)}`;
}

/**
 * Canonical home/create landing route.
 *
 * Home and new conversation are the same surface: compose hero + list nav.
 * Legacy `/conversations/new` redirects here.
 */
export const NEW_CONVERSATION_PATH = "/";

/** True when the path is the home/create landing (no open thread). */
export function isNewConversationPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/conversations/new";
}
