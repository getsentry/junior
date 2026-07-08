/**
 * Visible conversation message port.
 *
 * Messages are immutable source facts recorded idempotently by source identity;
 * the only mutable bookkeeping is the `replied_at` delivery mark.
 */

/** Author role of a visible conversation message. */
export type ConversationMessageRole = "user" | "assistant" | "system";

/** A source message to record; identity is `(conversationId, messageId)`. */
export interface NewConversationMessage {
  messageId: string;
  role: ConversationMessageRole;
  text: string;
  authorIdentityId?: string;
  meta?: Record<string, unknown>;
  createdAtMs: number;
}

/** A visible message read back from storage. */
export interface ConversationMessage {
  conversationId: string;
  messageId: string;
  role: ConversationMessageRole;
  text: string;
  authorIdentityId?: string;
  meta?: Record<string, unknown>;
  repliedAtMs?: number;
  createdAtMs: number;
}

/** Persist and read the visible per-conversation message transcript. */
export interface ConversationMessageStore {
  /** Record source messages idempotently by `(conversation_id, message_id)`. */
  record(
    conversationId: string,
    messages: NewConversationMessage[],
  ): Promise<void>;
  /** Set the mutable `replied_at` mark; content columns are never touched. */
  markReplied(
    conversationId: string,
    messageId: string,
    repliedAtMs: number,
  ): Promise<void>;
  /** List messages in `created_at` order. */
  list(
    conversationId: string,
    opts?: { limit?: number },
  ): Promise<ConversationMessage[]>;
}
