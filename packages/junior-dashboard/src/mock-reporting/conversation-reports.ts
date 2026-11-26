import {
  conversationDetailQuerySchema,
  conversationFeedQuerySchema,
  type ConversationFeed,
  type ConversationFeedItem,
} from "@sentry/junior/api/schema";
import type { z } from "zod";
import { filterMockConversationsByRepository } from "./code-repository";
import { mockConversationFeedPage } from "./feed-page";
import {
  NOW_MS,
  readMockConversationDetail,
  readMockConversationFeed,
  readMockConversationPendingMessages,
  withMockImageOrigin,
} from "./fixtures";
import { withMockViewerAnswers } from "./inbox-items";
import { withMockReadPosition } from "./read-positions";
import {
  filterMockConversationsBySpace,
  withMockSpace,
  withMockSpaces,
} from "./spaces";

type FeedQuery = z.output<typeof conversationFeedQuerySchema>;
type DetailQuery = z.output<typeof conversationDetailQuerySchema>;

/** Keep feed row `links` and `media` only where `include=` asks, as the API does. */
function withMockFeedIncludes(
  feed: ConversationFeed,
  include: readonly ("links" | "media")[],
): ConversationFeed {
  const strip = (item: ConversationFeedItem): ConversationFeedItem => {
    const { links, media, threads, ...row }: ConversationFeedItem = item;
    const kept: ConversationFeedItem = row;
    if (links && include.includes("links")) kept.links = links;
    if (media && include.includes("media")) kept.media = media;
    if (threads) kept.threads = threads.map(strip);
    return kept;
  };
  return { ...feed, conversations: feed.conversations.map(strip) };
}

/**
 * Build the page that `GET /conversations` answers, with image URLs on
 * `origin`. Undefined means the cursor is invalid.
 */
export function readMockConversationFeedPage(
  query: FeedQuery,
  origin: string,
): ConversationFeed | undefined {
  const repositoryId = query.codeRepositoryId;
  const { spaceId } = query;
  const readFeed = (status: "active" | "archived") => {
    const feed = withMockSpaces(
      readMockConversationFeed(query.actorEmail, status),
    );
    // Like the API, only the viewer's own feed says what they answered.
    if (repositoryId)
      return filterMockConversationsByRepository(feed, repositoryId);
    if (spaceId) return filterMockConversationsBySpace(feed, spaceId);
    return query.actorEmail ? feed : withMockViewerAnswers(feed, NOW_MS);
  };
  const respond = (feed: ConversationFeed) => {
    const page = mockConversationFeedPage(feed, {
      ...(query.cursor ? { cursor: query.cursor } : undefined),
      pinsFirst:
        !query.q && !repositoryId && !spaceId && query.status === "active",
    });
    return page
      ? withMockImageOrigin(withMockFeedIncludes(page, query.include), origin)
      : undefined;
  };
  const report = readFeed(query.status);
  if (!query.q) return respond(report);
  const archived = readFeed("archived");
  const search = query.q.toLowerCase();
  const conversations = new Map(
    [...report.conversations, ...archived.conversations].map((conversation) => [
      conversation.conversationId,
      conversation,
    ]),
  );
  return respond({
    ...report,
    conversations: [...conversations.values()].filter((conversation) =>
      conversation.displayTitle.toLowerCase().includes(search),
    ),
  });
}

/**
 * Build the detail that `GET /conversations/:conversationId` answers, with
 * the mailbox when the query asks for it. Undefined means not found.
 */
export function readMockConversationDetailReport(
  conversationId: string,
  query: DetailQuery,
) {
  const report = readMockConversationDetail(conversationId, query.limit);
  if (!report) return undefined;
  const detail = withMockSpace(withMockReadPosition(report));
  const mailbox = query.mailbox
    ? readMockConversationPendingMessages(conversationId)
    : undefined;
  return { detail, mailbox };
}
