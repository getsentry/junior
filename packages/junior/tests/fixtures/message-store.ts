import type {
  ConversationMessage,
  ConversationMessageStore,
  NewConversationMessage,
} from "@/chat/conversations/messages";

/** In-memory ConversationMessageStore for hermetic unit/component tests. */
export function createMemoryConversationMessageStore(): ConversationMessageStore {
  const rows = new Map<string, Map<string, ConversationMessage>>();

  function conversationRows(
    conversationId: string,
  ): Map<string, ConversationMessage> {
    let existing = rows.get(conversationId);
    if (!existing) {
      existing = new Map();
      rows.set(conversationId, existing);
    }
    return existing;
  }

  return {
    async record(
      conversationId: string,
      messages: NewConversationMessage[],
    ): Promise<void> {
      const store = conversationRows(conversationId);
      for (const message of messages) {
        const existing = store.get(message.messageId);
        if (existing) {
          // Mirrors SQL ON CONFLICT: source facts stay immutable, meta refreshes.
          store.set(message.messageId, {
            ...existing,
            ...(message.meta !== undefined ? { meta: message.meta } : {}),
          });
          continue;
        }
        store.set(message.messageId, {
          conversationId,
          messageId: message.messageId,
          role: message.role,
          text: message.text,
          createdAtMs: message.createdAtMs,
          ...(message.authorIdentityId
            ? { authorIdentityId: message.authorIdentityId }
            : {}),
          ...(message.meta !== undefined ? { meta: message.meta } : {}),
        });
      }
    },

    async markReplied(
      conversationId: string,
      messageId: string,
      repliedAtMs: number,
    ): Promise<void> {
      const existing = conversationRows(conversationId).get(messageId);
      if (existing && existing.repliedAtMs === undefined) {
        existing.repliedAtMs = repliedAtMs;
      }
    },

    async list(
      conversationId: string,
      opts: { limit?: number } = {},
    ): Promise<ConversationMessage[]> {
      const all = [...conversationRows(conversationId).values()].sort(
        (left, right) =>
          left.createdAtMs - right.createdAtMs ||
          left.messageId.localeCompare(right.messageId),
      );
      return opts.limit === undefined ? all : all.slice(0, opts.limit);
    },
  };
}
