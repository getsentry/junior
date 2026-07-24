import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  ConversationDetailReport,
  ConversationEventPage,
  ConversationUpdatesReport,
} from "@sentry/junior/api/schema";

/** Append one forward update while preserving detail-only fields. */
export function mergeConversationUpdate(
  current: ConversationDetailReport,
  update: ConversationUpdatesReport,
): ConversationDetailReport {
  const existingSeqs = new Set(current.events.map((event) => event.seq));
  return {
    ...current,
    ...update,
    events: [
      ...current.events,
      ...update.events.filter((event) => !existingSeqs.has(event.seq)),
    ],
    modelUsage: update.modelUsage ?? current.modelUsage,
    previousCursor: current.previousCursor,
    sentryConversationUrl: current.sentryConversationUrl,
  };
}

/** Prepend one backward event page without replacing the live detail cursor. */
export function mergeConversationEventPage(
  current: ConversationDetailReport,
  page: ConversationEventPage,
): ConversationDetailReport {
  const existingSeqs = new Set(current.events.map((event) => event.seq));
  return {
    ...current,
    events: [
      ...page.events.filter((event) => !existingSeqs.has(event.seq)),
      ...current.events,
    ],
    eventHistory: page.eventHistory,
    previousCursor: page.previousCursor,
  };
}

/**
 * Stop an in-flight poll and prepend history to the latest cached transcript.
 *
 * Returns `refresh` when retention or authorization changed while the history
 * request was in flight and the caller should reload conversation detail.
 */
export async function applyConversationEventPage(
  queryClient: QueryClient,
  queryKey: QueryKey,
  page: ConversationEventPage,
): Promise<"merged" | "missing" | "refresh"> {
  await queryClient.cancelQueries({ exact: true, queryKey });
  let result: "merged" | "missing" | "refresh" = "missing";
  queryClient.setQueryData<ConversationDetailReport>(queryKey, (current) => {
    if (!current) return current;
    if (page.eventHistory.status !== current.eventHistory.status) {
      result = "refresh";
      return current;
    }
    result = "merged";
    return mergeConversationEventPage(current, page);
  });
  return result;
}
