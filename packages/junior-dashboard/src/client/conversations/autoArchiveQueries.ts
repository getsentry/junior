import { useMutation, useQueryClient } from "@tanstack/react-query";
import { archiveDoneConversationsResponseSchema } from "@sentry/junior/api/schema";

import { post } from "../http";
import { invalidateConversationFeeds } from "./conversationFeedCache";

/** Archive all of the viewer's done conversations once. */
export function useArchiveDoneConversations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      post(
        archiveDoneConversationsResponseSchema,
        "/api/conversations/archive-done",
        {},
      ),
    onSuccess: async () => {
      await invalidateConversationFeeds(queryClient);
    },
  });
}
