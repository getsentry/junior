import type { QueryClient } from "@tanstack/react-query";

import {
  invalidateReviewItemListsOfConversation,
  reviewItemListQueryKey,
} from "../inbox/queries";

const CONVERSATION_SIDE_READS = [
  "agents",
  "memories",
  "plan",
  "watches",
] as const;

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
 * Refresh the side reads and this Conversation's Review item list when a
 * fetch brings a new ETag. Side reads do not poll. A new ETag means the
 * Conversation changed, so the details panel may be stale too. Only mounted
 * reads refetch.
 *
 * The transcript reads its open items from that list. Other lists, such as
 * the Inbox, also refresh when they show an item of this Conversation: the
 * item's subject card reads this detail, which polls on its own, so the
 * card must not show a change, such as a merge, before the list shows that
 * the item closed. The `reviewItems` token in `/api/versions` refreshes the
 * count and the waiting Conversations: both read only the open items that
 * need the viewer, which that token covers.
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
  void invalidateReviewItemListsOfConversation(client, conversationId);
}
