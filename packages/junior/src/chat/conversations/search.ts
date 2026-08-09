/** One relevant chat-message match from a prior conversation. */
export interface ConversationSearchResult {
  authorUserId?: string;
  channelName?: string;
  conversationId: string;
  excerpt: string;
  messageCreatedAtMs: number;
  messageId: string;
  providerDestinationId: string;
  role: "assistant" | "user";
}

/** Runtime-derived public workspace scope for cross-conversation search. */
export interface ConversationSearchScope {
  kind: "public_provider_tenant";
  provider: "slack";
  providerTenantId: string;
}

/** Optional filters that narrow retained public workspace search. */
export interface ConversationSearchFilters {
  /** Slack user id of the visible message author. */
  authorUserId?: string;
  /** Slack channel id of the conversation destination. */
  channelId?: string;
  /** Full-text query over retained visible message text. */
  query?: string;
}

/** Search retained public messages within an authorized workspace. */
export interface ConversationSearchStore {
  search(args: {
    currentConversationId: string;
    filters: ConversationSearchFilters;
    limit: number;
    scope: ConversationSearchScope;
  }): Promise<ConversationSearchResult[]>;
}
