import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ConversationDetailReport,
  ConversationFeed,
} from "@sentry/junior/api/schema";
import { pinConversationResponseSchema } from "@sentry/junior/api/schema";

import { patch } from "../http";
import { conversationDetailQueryKey } from "./queries";

type DetailCache = ConversationDetailReport & { detailEtag?: string };

/**
 * Pin or unpin one conversation for the viewer. The feed and detail caches
 * change at once, so the row moves to or from the Pinned section before the
 * request returns. A failed request puts the old caches back.
 */
export function usePinConversation(
  conversationId: string,
  options?: { onError?(pinned: boolean): void },
) {
  const queryClient = useQueryClient();
  const feeds = { queryKey: ["dashboard", "conversations"] };
  const detailQueryKey = conversationDetailQueryKey(conversationId);
  const setPinnedAt = (pinnedAt: string | null) => {
    queryClient.setQueriesData<ConversationFeed>(feeds, (feed) =>
      feed
        ? {
            ...feed,
            conversations: feed.conversations.map((conversation) =>
              conversation.conversationId === conversationId
                ? { ...conversation, pinnedAt }
                : conversation,
            ),
          }
        : feed,
    );
    // Clear the etag so the next read gets a full body, not a 304 that keeps
    // this local value.
    queryClient.setQueryData<DetailCache>(detailQueryKey, (detail) =>
      detail ? { ...detail, detailEtag: undefined, pinnedAt } : detail,
    );
  };
  return useMutation({
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
      const previous = {
        detail: queryClient.getQueryData<DetailCache>(detailQueryKey),
        feeds: queryClient.getQueriesData<ConversationFeed>(feeds),
      };
      setPinnedAt(pinned ? new Date().toISOString() : null);
      return previous;
    },
    onError: (_error, pinned, previous) => {
      previous?.feeds.forEach(([queryKey, feed]) => {
        queryClient.setQueryData(queryKey, feed);
      });
      queryClient.setQueryData(detailQueryKey, previous?.detail);
      options?.onError?.(pinned);
    },
    onSuccess: (result) => setPinnedAt(result.pinnedAt),
    // A reader's first pin adds the conversation to their feed.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries(feeds),
        queryClient.invalidateQueries({
          exact: true,
          queryKey: detailQueryKey,
        }),
      ]),
  });
}
