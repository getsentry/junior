import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { conversationDeliveryResponseSchema } from "@sentry/junior/api/schema";

import { patch } from "../http";
import { conversationDetailQueryKey } from "./queries";

/**
 * Detach a conversation from its Slack thread, so updates stay here, or
 * attach it again.
 */
export function useConversationDelivery(conversationId: string) {
  const queryClient = useQueryClient();
  const detailQueryKey = conversationDetailQueryKey(conversationId);
  return useMutation({
    mutationFn: (paused: boolean) =>
      patch(
        conversationDeliveryResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/delivery`,
        { paused },
      ),
    onSuccess: (result) => {
      // Clear the etag so the next read gets a full body, not a 304 that
      // keeps this local value.
      queryClient.setQueryData<
        ConversationDetailReport & { detailEtag?: string }
      >(detailQueryKey, (detail) =>
        detail
          ? { ...detail, deliveryPaused: result.paused, detailEtag: undefined }
          : detail,
      );
    },
  });
}
