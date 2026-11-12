import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  archiveDoneConversationsResponseSchema,
  conversationAutoArchiveSchema,
  type ConversationDetailReport,
} from "@sentry/junior/api/schema";

import { patch, post } from "../http";
import { conversationDetailQueryKey } from "./queries";

/** Turn auto-archive on or off for one conversation and the viewer. */
export function useSetConversationAutoArchive(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (autoArchive: boolean) =>
      patch(
        conversationAutoArchiveSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/auto-archive`,
        { autoArchive },
      ),
    onSuccess: (result) => {
      queryClient.setQueryData<
        ConversationDetailReport & { detailEtag?: string }
      >(conversationDetailQueryKey(conversationId), (detail) =>
        detail
          ? {
              ...detail,
              autoArchive: result.autoArchive,
              detailEtag: undefined,
            }
          : detail,
      );
    },
  });
}

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
      await queryClient.invalidateQueries({
        queryKey: ["dashboard", "conversations"],
      });
    },
  });
}
