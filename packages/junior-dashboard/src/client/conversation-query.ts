import type { QueryClient } from "@tanstack/react-query";
import type {
  ConversationDetailReport,
  ConversationEventPage,
} from "@sentry/junior/api/schema";

import { mergeConversationEventPage } from "./conversation-state";

/**
 * Stop an in-flight poll and prepend history to the requested transcript.
 *
 * Refresh detail when retention or authorization changed while the history
 * request was in flight.
 */
export async function applyConversationEventPage(
  queryClient: QueryClient,
  conversationId: string,
  page: ConversationEventPage,
): Promise<void> {
  const queryKey = ["conversation", conversationId] as const;
  await queryClient.cancelQueries({ exact: true, queryKey });
  let refresh = false;
  queryClient.setQueryData<ConversationDetailReport>(queryKey, (current) => {
    if (!current) return current;
    if (page.eventHistory.status !== current.eventHistory.status) {
      refresh = true;
      return current;
    }
    return mergeConversationEventPage(current, page);
  });
  if (refresh) {
    await queryClient.invalidateQueries({ exact: true, queryKey });
  }
}
