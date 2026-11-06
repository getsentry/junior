import type { InfiniteData } from "@tanstack/react-query";
import type {
  ConversationFeed,
  ConversationSummaryReport,
} from "@sentry/junior/api/schema";

/**
 * One cached conversation feed. The viewer's feed keeps its loaded pages; a
 * code repository feed keeps one response.
 */
export type ConversationFeedCache =
  | ConversationFeed
  | InfiniteData<ConversationFeed, string | undefined>;

function isPagedFeed(
  cache: ConversationFeedCache,
): cache is InfiniteData<ConversationFeed, string | undefined> {
  return "pages" in cache;
}

/**
 * Join loaded pages into one feed. New activity moves a row to an earlier
 * page, so a row can be in two pages; the earlier page is newer and wins.
 */
export function joinConversationFeedPages(
  data: InfiniteData<ConversationFeed, string | undefined>,
): ConversationFeed {
  const seen = new Set<string>();
  const conversations = data.pages.flatMap((page) =>
    page.conversations.filter((conversation) => {
      if (seen.has(conversation.conversationId)) return false;
      seen.add(conversation.conversationId);
      return true;
    }),
  );
  const first = data.pages[0]!;
  return {
    conversations,
    generatedAt: first.generatedAt,
    source: first.source,
  };
}

/** Read every cached row of one feed, in feed order. */
export function conversationFeedCacheRows(
  cache: ConversationFeedCache,
): ConversationSummaryReport[] {
  return isPagedFeed(cache)
    ? cache.pages.flatMap((page) => page.conversations)
    : cache.conversations;
}

/**
 * Change the cached rows of one feed. `map` runs once for each page, and
 * `first` is true only for the first page, where new rows go.
 */
export function mapConversationFeedCache(
  cache: ConversationFeedCache,
  map: (
    conversations: ConversationSummaryReport[],
    first: boolean,
  ) => ConversationSummaryReport[],
): ConversationFeedCache {
  if (!isPagedFeed(cache)) {
    return { ...cache, conversations: map(cache.conversations, true) };
  }
  return {
    ...cache,
    pages: cache.pages.map((page, index) => ({
      ...page,
      conversations: map(page.conversations, index === 0),
    })),
  };
}
