import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationFeed } from "@sentry/junior/api/schema";
import { markConversationUnreadResponseSchema } from "@sentry/junior/api/schema";

import { patch } from "../http";

/**
 * Mark one conversation read or unread for the viewer. The feed cache changes
 * at once, so the row moves to or from Needs attention before the request
 * returns. A failed request puts the old feeds back.
 */
export function useMarkConversationUnread(
  conversationId: string,
  options?: { onError?(unread: boolean): void },
) {
  const queryClient = useQueryClient();
  const feeds = { queryKey: ["dashboard", "conversations"] };
  return useMutation({
    mutationFn: (unread: boolean) =>
      patch(
        markConversationUnreadResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/unread`,
        { unread },
      ),
    onMutate: async (unread) => {
      await queryClient.cancelQueries(feeds);
      const previous = queryClient.getQueriesData<ConversationFeed>(feeds);
      queryClient.setQueriesData<ConversationFeed>(feeds, (feed) =>
        feed
          ? {
              ...feed,
              conversations: feed.conversations.map((conversation) =>
                conversation.conversationId === conversationId
                  ? { ...conversation, unread: unread || undefined }
                  : conversation,
              ),
            }
          : feed,
      );
      return previous;
    },
    onError: (_error, unread, previous) => {
      previous?.forEach(([queryKey, feed]) => {
        queryClient.setQueryData(queryKey, feed);
      });
      options?.onError?.(unread);
    },
    onSettled: () => queryClient.invalidateQueries(feeds),
  });
}
