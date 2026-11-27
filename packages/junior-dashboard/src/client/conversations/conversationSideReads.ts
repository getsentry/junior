import type { QueryClient } from "@tanstack/react-query";

const CONVERSATION_SIDE_READS = [
  "agents",
  "memories",
  "questions",
  "todos",
  "watches",
] as const;

/**
 * Key a read that shows beside the detail report, such as in the details
 * panel or the transcript's questions. A detail change refreshes it.
 */
export function conversationSideReadQueryKey(
  conversationId: string,
  read: (typeof CONVERSATION_SIDE_READS)[number],
) {
  return ["conversation", conversationId, read] as const;
}

/**
 * Refresh the side reads when a fetch brings a new ETag. Side reads do not
 * poll. A new ETag means the Conversation changed, so the details panel and
 * the transcript's questions may be stale too. Only mounted reads refetch.
 * The Inbox's reads refresh from the `inboxItems` token in `/api/versions`.
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
}
