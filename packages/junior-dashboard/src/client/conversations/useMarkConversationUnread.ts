import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ConversationDetailReport,
  ConversationFeed,
} from "@sentry/junior/api/schema";
import { conversationReadPositionSchema } from "@sentry/junior/api/schema";

import { patch } from "../http";
import { conversationDetailQueryKey } from "./queries";

type DetailCache = ConversationDetailReport & { detailEtag?: string };

/**
 * Mark one conversation read or unread for the viewer. The feed and detail
 * caches change at once, so the row moves to or from Needs attention before
 * the request returns. A failed request puts the old caches back.
 */
export function useMarkConversationUnread(
  conversationId: string,
  options?: { onError?(unread: boolean): void },
) {
  const queryClient = useQueryClient();
  const feeds = { queryKey: ["dashboard", "conversations"] };
  const detailQueryKey = conversationDetailQueryKey(conversationId);
  return useMutation({
    mutationFn: (unread: boolean) =>
      patch(
        conversationReadPositionSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/unread`,
        { unread },
      ),
    onMutate: async (unread) => {
      await Promise.all([
        queryClient.cancelQueries(feeds),
        queryClient.cancelQueries({ queryKey: detailQueryKey }),
      ]);
      const previous = {
        detail: queryClient.getQueryData<DetailCache>(detailQueryKey),
        feeds: queryClient.getQueriesData<ConversationFeed>(feeds),
      };
      const mark = { unread: unread || undefined };
      queryClient.setQueriesData<ConversationFeed>(feeds, (feed) =>
        feed
          ? {
              ...feed,
              conversations: feed.conversations.map((conversation) =>
                conversation.conversationId === conversationId
                  ? { ...conversation, ...mark }
                  : conversation,
              ),
            }
          : feed,
      );
      // Clear the etag so the next read gets a full body, not a 304 that keeps
      // this local value.
      queryClient.setQueryData<DetailCache>(detailQueryKey, (detail) =>
        detail ? { ...detail, ...mark, detailEtag: undefined } : detail,
      );
      return previous;
    },
    onError: (_error, unread, previous) => {
      previous?.feeds.forEach(([queryKey, feed]) => {
        queryClient.setQueryData(queryKey, feed);
      });
      queryClient.setQueryData(detailQueryKey, previous?.detail);
      options?.onError?.(unread);
    },
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
