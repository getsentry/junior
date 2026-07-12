/** One relevant visible-message match from a prior conversation. */
export interface ConversationSearchResult {
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

/** Search retained public visible messages within an authorized workspace. */
export interface ConversationSearchStore {
  search(args: {
    currentConversationId: string;
    limit: number;
    query: string;
    scope: ConversationSearchScope;
  }): Promise<ConversationSearchResult[]>;
}
