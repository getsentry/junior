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
