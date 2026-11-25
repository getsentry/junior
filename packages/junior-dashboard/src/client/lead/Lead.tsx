import { leadSchema } from "@sentry/junior/api/schema";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { fetchDashboardJson } from "../http";
import { spaceApiPath, spaceLeadKey } from "../spaces/queries";

/**
 * Find a Space's Lead, the Conversation that its page shows, with the
 * Conversations it watches. A member's read makes the Lead. A non-member's
 * read fails until a member makes it.
 */
export function useSpaceLead(spaceId: string | undefined) {
  return useQuery({
    enabled: Boolean(spaceId),
    queryKey: spaceLeadKey(spaceId),
    queryFn: ({ signal }) =>
      fetchDashboardJson(leadSchema, `${spaceApiPath(spaceId!)}/lead`, signal),
    retry: false,
    // The Lead's id never changes. Its Watches change in its Turns, and
    // `useLeadWatchRefresh` reads them again then.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Tell whether a Conversation page shows a Lead, and whether the page knows
 * that yet. It waits for the detail, so the wrong chrome does not flash.
 */
export function useLeadPageKind(detail: { kind: string } | undefined) {
  return {
    known: detail !== undefined,
    lead: detail?.kind === "lead",
  };
}

/**
 * Read the Lead's Watches again when its transcript shows an event that the
 * last Lead read had not seen, since only the Lead's own Turns add or stop
 * them.
 */
export function useLeadWatchRefresh(
  spaceId: string | undefined,
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
      queryKey: spaceLeadKey(spaceId),
    });
  }, [lastSeq, queryClient, readSeq, spaceId]);
}
