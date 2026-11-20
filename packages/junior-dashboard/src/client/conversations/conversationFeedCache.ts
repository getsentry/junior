import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type {
  ConversationFeed,
  ConversationFeedItem,
} from "@sentry/junior/api/schema";

/** One loaded page of the viewer's feed, with the version of its body. */
export type ConversationFeedPage = ConversationFeed & { pageVersion?: string };

/**
 * One cached conversation feed. The viewer's feed keeps its loaded pages; a
 * code repository feed keeps one response.
 */
export type ConversationFeedCache =
  | ConversationFeed
  | InfiniteData<ConversationFeedPage, string | undefined>;

function isPagedFeed(
  cache: ConversationFeedCache,
): cache is InfiniteData<ConversationFeedPage, string | undefined> {
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
): ConversationFeedItem[] {
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
    conversations: ConversationFeedItem[],
    first: boolean,
  ) => ConversationFeedItem[],
): ConversationFeedCache {
  if (!isPagedFeed(cache)) {
    return { ...cache, conversations: map(cache.conversations, true) };
  }
  return {
    ...cache,
    // A changed page no longer matches the body that its version names, so
    // the next read gets the whole page.
    pages: cache.pages.map(({ pageVersion: _pageVersion, ...page }, index) => ({
      ...page,
      conversations: map(page.conversations, index === 0),
    })),
  };
}

/**
 * Refresh every cached Conversation feed after a change that can add, move,
 * or remove a feed row. The client cannot tell which feeds list the row, so
 * the change refreshes the feed family. Only mounted feeds refetch. Prefer an
 * optimistic `setQueriesData` patch and the versions poll when the change is
 * known in full.
 */
export function invalidateConversationFeeds(queryClient: QueryClient) {
  // oxlint-disable-next-line query-invalidation/no-broad-query-invalidation -- Any feed can list the changed row.
  return queryClient.invalidateQueries({
    queryKey: ["dashboard", "conversations"],
  });
}
