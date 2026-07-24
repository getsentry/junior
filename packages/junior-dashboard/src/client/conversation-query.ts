import type { QueryClient } from "@tanstack/react-query";
import type {
  ConversationDetailReport,
  ConversationEventPage,
} from "@sentry/junior/api/schema";

import {
  mergeCompleteConversationHistory,
  mergeConversationEventPage,
} from "./conversation-state";

/**
 * Stop an in-flight poll and prepend history to the requested transcript.
 *
 * Refresh detail when retention or authorization changed while the history
 * request was in flight.
 */
export async function applyConversationEventPage(
  queryClient: QueryClient,
  conversationId: string,
  page: ConversationEventPage | undefined,
  refreshed?: ConversationDetailReport,
): Promise<void> {
  const queryKey = ["conversation", conversationId] as const;
  await queryClient.cancelQueries({ exact: true, queryKey });
  let refresh = false;
  queryClient.setQueryData<ConversationDetailReport>(queryKey, (current) => {
    if (!current) return current;
    if (!current.previousCursor) return current;
    if (
      refreshed &&
      refreshed.eventHistory.status !== current.eventHistory.status
    ) {
      refresh = true;
      return current;
    }
    const anchored = refreshed
      ? { ...current, previousCursor: refreshed.previousCursor }
      : current;
    if (!page) return anchored;
    if (page.eventHistory.status !== anchored.eventHistory.status) {
      refresh = true;
      return anchored;
    }
    return mergeConversationEventPage(anchored, page);
  });
  if (refresh) {
    await queryClient.invalidateQueries({ exact: true, queryKey });
  }
}

/** Commit a fully drained history without allowing a stale poll to replace it. */
export async function applyCompleteConversationHistory(
  queryClient: QueryClient,
  conversationId: string,
  complete: ConversationDetailReport,
): Promise<void> {
  const queryKey = ["conversation", conversationId] as const;
  await queryClient.cancelQueries({ exact: true, queryKey });
  queryClient.setQueryData<ConversationDetailReport>(queryKey, (current) =>
    current ? mergeCompleteConversationHistory(current, complete) : complete,
  );
}
