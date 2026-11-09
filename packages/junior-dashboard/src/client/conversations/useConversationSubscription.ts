import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { conversationSubscriptionResponseSchema } from "@sentry/junior/api/schema";

import { patch } from "../http";
import { conversationDetailQueryKey } from "./queries";

/**
 * Subscribe the viewer to one conversation, or unsubscribe them. An
 * unsubscribe drops the viewer's pin, and it archives the conversation when
 * the viewer was the last subscriber.
 */
export function useConversationSubscription(conversationId: string) {
  const queryClient = useQueryClient();
  const detailQueryKey = conversationDetailQueryKey(conversationId);
  return useMutation({
    mutationFn: (subscribed: boolean) =>
      patch(
        conversationSubscriptionResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/subscription`,
        { subscribed },
      ),
    onSuccess: (result) => {
      // Clear the etag so the next read gets a full body, not a 304 that
      // keeps this local value.
      queryClient.setQueryData<
        ConversationDetailReport & { detailEtag?: string }
      >(detailQueryKey, (detail) =>
        detail
          ? {
              ...detail,
              archivedAt: result.archivedAt,
              ...(result.subscribed
                ? undefined
                : { pinnedAt: null, pinPosition: undefined }),
              subscribed: result.subscribed,
              detailEtag: undefined,
            }
          : detail,
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: ["dashboard", "conversations"],
      }),
  });
}
