/** Build the dashboard route for a conversation id. */
export function conversationPath(conversationId: string): string {
  return `/conversations/${encodeURIComponent(conversationId)}`;
}

/** Dashboard home route. Legacy `/conversations/new` redirects here. */
export const NEW_CONVERSATION_PATH = "/";

/** True when the path shows the dashboard home page. */
export function isNewConversationPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/conversations/new";
}
