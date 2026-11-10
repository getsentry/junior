import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { conversationDetailReportSchema } from "@sentry/junior/api/schema";
import { useQueries } from "@tanstack/react-query";

import { conversationDetailTitle } from "../format";
import { fetchDashboardJson } from "../http";

/** A Conversation's current Brief. */
export type ConversationBriefReport = NonNullable<
  ConversationDetailReport["brief"]
>;

/**
 * Read a Conversation's title and Brief from its first page. Lists and the
 * inbox share this read, so each Conversation loads once.
 *
 * Prototype: list summaries have no Brief, so each row reads its detail.
 * The real change adds the Brief outcome and summary to the summary report.
 */
export function conversationGlanceQuery(conversationId: string) {
  return {
    queryKey: ["dashboard", "conversation-glance", conversationId],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const detail = await fetchDashboardJson(
        conversationDetailReportSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}?limit=1`,
        signal,
      );
      return {
        brief: detail.brief ?? null,
        title: conversationDetailTitle(detail) ?? null,
      };
    },
    retry: false,
    staleTime: 5 * 60_000,
  };
}

/** The Briefs of some Conversations, in order. */
export function useConversationBriefs(
  conversationIds: readonly string[],
): (ConversationBriefReport | undefined)[] {
  return useQueries({
    queries: conversationIds.map(conversationGlanceQuery),
  }).map((query) => query.data?.brief ?? undefined);
}
