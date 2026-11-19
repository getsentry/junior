import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { pinConversationResponseSchema } from "@sentry/junior/api/schema";

import { patch } from "../http";
import {
  conversationFeedCacheRows,
  invalidateConversationFeeds,
  mapConversationFeedCache,
  type ConversationFeedCache,
} from "./conversationFeedCache";
import { conversationDetailQueryKey } from "./queries";

type DetailCache = ConversationDetailReport & { detailEtag?: string };

const PIN_MUTATION_KEY = ["dashboard", "conversation-pin"];

/** The viewer's marks on one Conversation that a pin changes. */
type ViewerMarks = {
  archivedAt?: string | null;
  pinnedAt?: string | null;
  pinPosition?: number;
};

/**
 * Pin or unpin one conversation for the viewer. The feed and detail caches
 * change at once, so the row moves to or from the Pinned section before the
 * request returns. A failed request puts back only this conversation's
 * marks, so a pin of another conversation in flight keeps its own.
 */
export function usePinConversation(
  conversationId: string,
  options?: { onError?(pinned: boolean): void; onSuccess?(): void },
) {
  const queryClient = useQueryClient();
  const feeds = { queryKey: ["dashboard", "conversations"] };
  const detailQueryKey = conversationDetailQueryKey(conversationId);
  const setMarks = (viewerMarks: ViewerMarks) =>
    queryClient.setQueriesData<ConversationFeedCache>(feeds, (feed) =>
      feed
        ? mapConversationFeedCache(feed, (conversations) =>
            conversations.map((conversation) =>
              conversation.conversationId === conversationId
                ? { ...conversation, ...viewerMarks }
                : conversation,
            ),
          )
        : feed,
    );
  const setPinnedAt = (pinnedAt: string | null) => {
    // Match the API: a pin also restores an archived conversation, and a new
    // or removed pin has no place in the Pinned order.
    const viewerMarks = pinnedAt
      ? { archivedAt: null, pinnedAt, pinPosition: undefined }
      : { pinnedAt, pinPosition: undefined };
    setMarks(viewerMarks);
    // Clear the etag so the next read gets a full body, not a 304 that keeps
    // this local value.
    queryClient.setQueryData<DetailCache>(detailQueryKey, (detail) =>
      detail ? { ...detail, ...viewerMarks, detailEtag: undefined } : detail,
    );
  };
  return useMutation({
    mutationKey: PIN_MUTATION_KEY,
    mutationFn: (pinned: boolean) =>
      patch(
        pinConversationResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/pin`,
        { pinned },
      ),
    onMutate: async (pinned) => {
      await Promise.all([
        queryClient.cancelQueries(feeds),
        queryClient.cancelQueries({ queryKey: detailQueryKey }),
      ]);
      const row = queryClient
        .getQueriesData<ConversationFeedCache>(feeds)
        .flatMap(([, feed]) => (feed ? conversationFeedCacheRows(feed) : []))
        .find((conversation) => conversation.conversationId === conversationId);
      const previous = {
        detail: queryClient.getQueryData<DetailCache>(detailQueryKey),
        marks: row && {
          archivedAt: row.archivedAt,
          pinnedAt: row.pinnedAt,
          pinPosition: row.pinPosition,
        },
      };
      setPinnedAt(pinned ? new Date().toISOString() : null);
      return previous;
    },
    onError: (_error, pinned, previous) => {
      if (previous?.marks) setMarks(previous.marks);
      queryClient.setQueryData(detailQueryKey, previous?.detail);
      options?.onError?.(pinned);
    },
    onSuccess: (result) => {
      setPinnedAt(result.pinnedAt);
      options?.onSuccess?.();
    },
    // A reader's first pin adds the conversation to their feed. A feed read
    // while another pin is in flight would undo that pin on screen.
    onSettled: () =>
      Promise.all([
        queryClient.isMutating({ mutationKey: PIN_MUTATION_KEY }) === 1
          ? invalidateConversationFeeds(queryClient)
          : undefined,
        queryClient.invalidateQueries({
          exact: true,
          queryKey: detailQueryKey,
        }),
      ]),
  });
}
