import { leadSchema } from "@sentry/junior/api/schema";
import { useQuery } from "@tanstack/react-query";

import { fetchDashboardJson } from "../http";
import { spaceApiPath, spaceLeadKey } from "../spaces/queries";

/**
 * Find a Space's Lead, the Conversation that its page shows.
 */
export function useSpaceLead(spaceId: string | undefined) {
  return useQuery({
    enabled: Boolean(spaceId),
    queryKey: spaceLeadKey(spaceId),
    queryFn: ({ signal }) =>
      fetchDashboardJson(leadSchema, `${spaceApiPath(spaceId!)}/lead`, signal),
    retry: false,
    // The Lead's id never changes.
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
