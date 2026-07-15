/**
 * Visible conversation message port.
 *
 * Conversation events are the source facts. This port atomically appends those
 * facts and maintains the SQL table used for hydration and indexed search.
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

/** Persist event-backed visible messages and read their SQL projection. */
export interface ConversationMessageStore {
  /** Append source facts and project them idempotently by message identity. */
  record(
    conversationId: string,
    messages: NewConversationMessage[],
  ): Promise<void>;
  /** Append a reply fact and project its immutable first timestamp. */
  markReplied(
    conversationId: string,
    messageId: string,
    repliedAtMs: number,
  ): Promise<void>;
  /** List the materialized read model in `created_at` order. */
  list(
    conversationId: string,
    opts?: { limit?: number },
  ): Promise<ConversationMessage[]>;
}
