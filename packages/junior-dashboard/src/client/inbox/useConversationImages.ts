import { useInfiniteQuery } from "@tanstack/react-query";
import { INPUT_IMAGE_TYPES } from "@sentry/junior/api/schema";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import {
  readConversationData,
  readConversationEvents,
} from "../conversations/queries";
import type { Conversation } from "../types";

/** One stored file of a Conversation, as the feed names it. */
export type ConversationMedia = NonNullable<Conversation["media"]>[number];

/**
 * The API's `CONVERSATION_FEED_MEDIA_LIMIT`, which its barrel doesn't
 * export. A feed row with this many files may have older ones.
 */
export const FEED_MEDIA_LIMIT = 3;

/** Whether a file shows as an image. */
export function isImageMedia(media: ConversationMedia): boolean {
  return INPUT_IMAGE_TYPES.some((type) => type === media.contentType);
}

// The stored files of a page of events, newest first. A Slack file that
// Junior has not stored yet has no file to show.
function pageImages(
  events: ConversationDetailReport["events"],
): ConversationMedia[] {
  const media: ConversationMedia[] = [];
  for (const { data } of [...events].reverse()) {
    if (data.type !== "message" && data.type !== "attachments_delivered") {
      continue;
    }
    for (const { contentType, filename, id, pending } of data.attachments ??
      []) {
      if (pending) continue;
      const file = { contentType, filename, id };
      if (isImageMedia(file)) media.push(file);
    }
  }
  return media;
}

/**
 * The images of one Conversation past the feed's newest few, newest first.
 * It reads the Conversation's history only once `enabled`: the newest page,
 * then older pages on `loadMore`, each cursor once. The key sits outside the feed's
 * `["dashboard", "conversations"]` prefix, which only holds feeds.
 */
export function useConversationImages(
  conversationId: string,
  enabled: boolean,
) {
  const query = useInfiniteQuery({
    queryKey: ["dashboard", "conversation-images", conversationId],
    queryFn: async ({ pageParam, signal }) => {
      const page = pageParam
        ? await readConversationEvents(conversationId, pageParam, signal)
        : await readConversationData(conversationId, signal);
      return {
        images: pageImages(page.events),
        previousCursor: page.previousCursor,
      };
    },
    // "" reads the newest page, from the Conversation's detail.
    initialPageParam: "",
    getNextPageParam: (page) => page.previousCursor,
    enabled,
    staleTime: 60_000,
  });
  return {
    done: query.isSuccess && !query.hasNextPage,
    images: query.data?.pages.flatMap((page) => page.images) ?? [],
    loadMore() {
      if (query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    },
    loading: query.isFetching,
    pages: query.data?.pages.length ?? 0,
  };
}
