/** Extract conversation and session identifiers from correlation context. */
export function getSessionIdentifiers(context: {
  correlation?: {
    conversationId?: string;
    threadId?: string;
    turnId?: string;
    runId?: string;
  };
}): {
  conversationId?: string;
  sessionId?: string;
} {
  return {
    conversationId:
      context.correlation?.conversationId ??
      context.correlation?.threadId ??
      context.correlation?.runId,
    sessionId: context.correlation?.turnId,
  };
}
