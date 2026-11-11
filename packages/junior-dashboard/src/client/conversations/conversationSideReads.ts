import type { QueryClient } from "@tanstack/react-query";

import {
  REVIEW_ITEM_DETAIL_QUERY_KEY,
  reviewItemListQueryKey,
} from "../review-desk/queries";

const CONVERSATION_SIDE_READS = ["agents", "memories", "watches"] as const;

/**
 * Key a read that shows beside the detail report, such as in the details
 * panel. A detail change refreshes it.
 */
export function conversationSideReadQueryKey(
  conversationId: string,
  read: (typeof CONVERSATION_SIDE_READS)[number],
) {
  return ["conversation", conversationId, read] as const;
}

/**
 * Refresh the side reads and this Conversation's Review items when a fetch
 * brings a new ETag. Side reads do not poll. A new ETag means the
 * Conversation changed, so the details panel may be stale too. Only mounted
 * reads refetch.
 *
 * The `reviewItems` token in `/api/versions` refreshes the count and the
 * waiting Conversations: both read only the open items that need the
 * viewer, which that token covers. It does not cover single items, which
 * can be notices, for Everyone, for other people, or closed. So the items
 * that the transcript shows refresh here.
 */
export function refreshSideReadsOnChange(
  client: QueryClient,
  conversationId: string,
  previous: { detailEtag?: string } | undefined,
  next: { detailEtag?: string },
) {
  if (
    !previous?.detailEtag ||
    !next.detailEtag ||
    previous.detailEtag === next.detailEtag
  ) {
    return;
  }
  for (const read of CONVERSATION_SIDE_READS) {
    void client.invalidateQueries({
      queryKey: conversationSideReadQueryKey(conversationId, read),
    });
  }
  void client.invalidateQueries({
    queryKey: reviewItemListQueryKey({ conversationId }),
  });
  void client.invalidateQueries({ queryKey: REVIEW_ITEM_DETAIL_QUERY_KEY });
}
