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

/** Runtime-derived public workspace scope for cross-conversation search. */
export interface ConversationMessageSearchScope {
  kind: "public_provider_tenant";
  provider: "slack";
  providerTenantId: string;
}

/** Optional filters that narrow retained public workspace search. */
export interface ConversationMessageSearchFilters {
  /** Only conversations active at or after this time. */
  activeAfterMs?: number;
  /** Only conversations active before this time. */
  activeBeforeMs?: number;
  /** Annotation key prefix, matched case-insensitively. */
  annotationKeyPrefix?: string;
  /** Plugin that owns the annotation key. */
  annotationPlugin?: string;
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
    scope: ConversationMessageSearchScope;
  }): Promise<ConversationMessageSearchResult[]>;
}
