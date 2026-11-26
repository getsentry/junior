import { useMutation, useQueryClient } from "@tanstack/react-query";
import { conversationLeaveResponseSchema } from "@sentry/junior/api/schema";

import { post } from "../http";
import { invalidateMemberSpaces } from "../spaces/queries";
import { invalidateConversationFeeds } from "./conversationFeedCache";
import { conversationDetailQueryKey } from "./queries";

/**
 * Leave one private conversation. The viewer loses access, so the caller
 * moves off the page. The API acts only on the viewer.
 */
export function useLeaveConversation(
  conversationId: string,
  options?: { onSuccess?(): void },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      post(
        conversationLeaveResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/leave`,
        {},
      ),
    onSuccess: () => {
      options?.onSuccess?.();
      // Drop the cached detail, so Back cannot show the transcript.
      queryClient.removeQueries({
        queryKey: conversationDetailQueryKey(conversationId),
      });
    },
    // A Lead's subscribed Participants are its Space's members.
    onSettled: () =>
      Promise.all([
        invalidateConversationFeeds(queryClient),
        invalidateMemberSpaces(queryClient),
      ]),
  });
}
