import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { conversationDeliveryResponseSchema } from "@sentry/junior/api/schema";

import { patch } from "../http";
import { withoutVersion } from "../revalidation";
import { conversationDetailQueryKey } from "./queries";

/**
 * Detach a conversation from its Slack thread, so updates stay here, or
 * attach it again.
 */
export function useConversationDelivery(
  conversationId: string,
  options?: { onError?(): void },
) {
  const queryClient = useQueryClient();
  const detailQueryKey = conversationDetailQueryKey(conversationId);
  return useMutation({
    onError: () => options?.onError?.(),
    mutationFn: (paused: boolean) =>
      patch(
        conversationDeliveryResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/delivery`,
        { paused },
      ),
    onSuccess: (result) => {
      queryClient.setQueryData<
        ConversationDetailReport & { detailEtag?: string }
      >(detailQueryKey, (detail) =>
        detail
          ? withoutVersion(
              { ...detail, deliveryPaused: result.paused },
              "detailEtag",
            )
          : detail,
      );
    },
  });
}
