import type { ConversationFeed } from "@sentry/junior/api/schema";

const MOCK_FEED_PAGE_SIZE = 50;

/**
 * Read one page of a mock feed like the API: pins come first on the first
 * page and are not paged, and `nextCursor` names the last row of the page.
 * Return undefined for a cursor that names no row.
 */
export function mockConversationFeedPage(
  feed: ConversationFeed,
  options: { cursor?: string; pinsFirst: boolean },
): ConversationFeed | undefined {
  const pinned = options.pinsFirst
    ? feed.conversations.filter((conversation) => conversation.pinnedAt)
    : [];
  const rows = options.pinsFirst
    ? feed.conversations.filter((conversation) => !conversation.pinnedAt)
    : feed.conversations;
  const start = options.cursor
    ? rows.findIndex(
        (conversation) => conversation.conversationId === options.cursor,
      ) + 1
    : 0;
  if (options.cursor && start === 0) return undefined;
  const page = rows.slice(start, start + MOCK_FEED_PAGE_SIZE);
  const last = page.at(-1);
  return {
    ...feed,
    conversations: options.cursor ? page : [...pinned, ...page],
    ...(last && start + MOCK_FEED_PAGE_SIZE < rows.length
      ? { nextCursor: last.conversationId }
      : undefined),
  };
}
