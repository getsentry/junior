/** One relevant chat-message match from a prior conversation. */
export interface ConversationMessageSearchResult {
  channelName?: string;
  conversationId: string;
  excerpt: string;
  messageCreatedAtMs: number;
  messageId: string;
  providerDestinationId: string;
  role: "assistant" | "user";
}

/** Optional filters that narrow retained public message search. */
export interface ConversationMessageSearchFilters {
  /** Only conversations active at or after this time. */
  afterMs?: number;
  /** Annotation key, matched case-insensitively. Nested keys may continue with `#`. */
  annotation?: string;
  /** Only conversations active before this time. */
  beforeMs?: number;
  /** Slack channel id of the conversation destination. */
  channelId?: string;
  /** Full-text query over retained visible message text. */
  query?: string;
}

/** Search retained public messages within an authorized workspace. */
export interface ConversationMessageSearchStore {
  search(args: {
    currentConversationId: string;
    filters: ConversationMessageSearchFilters;
    limit: number;
  }): Promise<ConversationMessageSearchResult[]>;
}
