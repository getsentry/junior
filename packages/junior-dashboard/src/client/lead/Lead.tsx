import { leadSchema } from "@sentry/junior/api/schema";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { fetchDashboardJson } from "../http";

const LEAD_QUERY_KEY = ["dashboard", "lead"] as const;

/**
 * Find or make the viewer's Lead, the Conversation that home shows, with the
 * Conversations it watches.
 */
export function useLead(enabled = true) {
  return useQuery({
    enabled,
    queryKey: LEAD_QUERY_KEY,
    queryFn: ({ signal }) =>
      fetchDashboardJson(leadSchema, "/api/lead", signal),
    retry: false,
    // The Lead's id never changes. Its Watches change in its Turns, and
    // `useLeadWatchRefresh` reads them again then.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Tell whether a Conversation page shows the Lead, and whether the page
 * knows that yet. Home and the narrow list know the Lead's id before its
 * detail loads. Without either, the page waits for the detail, so the wrong
 * chrome does not flash.
 */
export function useLeadPageKind(
  conversationId: string,
  detail: { kind: string } | undefined,
) {
  const leadId = useLead(false).data?.conversationId;
  return {
    known: detail !== undefined || leadId !== undefined,
    lead: detail?.kind === "lead" || leadId === conversationId,
  };
}

/**
 * Read the Lead's Watches again when its transcript shows an event that the
 * last Lead read had not seen, since only the Lead's own Turns add or stop
 * them.
 */
export function useLeadWatchRefresh(
  lastSeq: number | undefined,
  readSeq: number | undefined,
) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (lastSeq === undefined || readSeq === undefined || lastSeq <= readSeq) {
      return;
    }
    void queryClient.invalidateQueries({
      exact: true,
      queryKey: LEAD_QUERY_KEY,
    });
  }, [lastSeq, queryClient, readSeq]);
}
