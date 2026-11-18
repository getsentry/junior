import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type {
  ConversationFeed,
  ConversationFeedItem,
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
 * `readThrough` is the oldest activity on the last page, once it is not the
 * first: the first page also holds every pin and each Conversation that
 * waits on the viewer, at any age, so only a later page says how far back
 * the feed has read.
 */
export function joinConversationFeedPages(
  data: InfiniteData<ConversationFeed, string | undefined>,
): ConversationFeed & { readThrough?: string } {
  const seen = new Set<string>();
  const conversations = data.pages.flatMap((page) =>
    page.conversations.filter((conversation) => {
      if (seen.has(conversation.conversationId)) return false;
      seen.add(conversation.conversationId);
      return true;
    }),
  );
  const first = data.pages[0]!;
  const last = data.pages.length > 1 ? data.pages.at(-1) : undefined;
  const readThrough = last?.conversations.reduce<string | undefined>(
    (oldest, conversation) =>
      oldest === undefined ||
      Date.parse(conversation.lastSeenAt) < Date.parse(oldest)
        ? conversation.lastSeenAt
        : oldest,
    undefined,
  );
  return {
    conversations,
    generatedAt: first.generatedAt,
    ...(readThrough ? { readThrough } : undefined),
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
    pages: cache.pages.map((page, index) => ({
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
