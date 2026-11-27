import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { conversationSubscriptionResponseSchema } from "@sentry/junior/api/schema";

import { patch } from "../http";
import { withoutVersion } from "../revalidation";
import { conversationDetailQueryKey } from "./queries";
import { invalidateMemberSpaces } from "../spaces/queries";
import { invalidateConversationFeeds } from "./conversationFeedCache";

/**
 * Subscribe the viewer to one conversation, or unsubscribe them. An
 * unsubscribe drops the viewer's pin, and it archives the conversation when
 * the viewer was the last subscriber.
 */
export function useConversationSubscription(
  conversationId: string,
  options?: { onError?(): void },
) {
  const queryClient = useQueryClient();
  const detailQueryKey = conversationDetailQueryKey(conversationId);
  return useMutation({
    onError: () => options?.onError?.(),
    mutationFn: (subscribed: boolean) =>
      patch(
        conversationSubscriptionResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/subscription`,
        { subscribed },
      ),
    onSuccess: (result) => {
      queryClient.setQueryData<
        ConversationDetailReport & { detailEtag?: string }
      >(detailQueryKey, (detail) =>
        detail
          ? withoutVersion(
              {
                ...detail,
                archivedAt: result.archivedAt,
                ...(result.subscribed
                  ? undefined
                  : { pinnedAt: null, pinPosition: undefined }),
                subscribed: result.subscribed,
              },
              "detailEtag",
            )
          : detail,
      );
    },
    // A Join makes the viewer a Participant, which changes what the detail
    // lets them do. A Lead's subscribed Participants are its Space's members.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: detailQueryKey }),
        invalidateConversationFeeds(queryClient),
        invalidateMemberSpaces(queryClient),
      ]),
  });
}
