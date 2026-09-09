import type { BriefLink, BriefOutcomeStatus } from "./brief";

/** One latest Brief match from a prior public Conversation. */
export interface ConversationBriefSearchResult {
  channelName?: string;
  conversationId: string;
  excerpt: string;
  links: BriefLink[];
  outcomeStatus: BriefOutcomeStatus;
  providerDestinationId?: string;
  summary: string;
  title?: string;
  updatedAtMs: number;
  version: number;
}

/** Public scope available to one Conversation Brief search. */
export type ConversationBriefSearchScope =
  | {
      kind: "public_provider_tenant";
      provider: "slack";
      providerTenantId: string;
    }
  | { kind: "public" };

/** Optional filters for latest public Brief search. */
export interface ConversationBriefSearchFilters {
  /** Only Briefs updated at or after this time. */
  afterMs?: number;
  /** Annotation key, matched case-insensitively. Nested keys may continue with `#`. */
  annotation?: string;
  /** Only Briefs updated before this time. */
  beforeMs?: number;
  /** Provider destination id, available for provider-tenant search. */
  channelId?: string;
  /** Full-text query over indexed Brief content. */
  query?: string;
  /** Current outcome status. */
  status?: BriefOutcomeStatus;
}

/** Search the latest Briefs within an authorized public scope. */
export interface ConversationBriefSearchStore {
  search(args: {
    currentConversationId: string;
    filters: ConversationBriefSearchFilters;
    limit: number;
    scope: ConversationBriefSearchScope;
  }): Promise<ConversationBriefSearchResult[]>;
}
