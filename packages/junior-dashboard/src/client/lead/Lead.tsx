import { useQuery } from "@tanstack/react-query";

import { spaceLeadQuery } from "../spaces/queries";

/**
 * Find a Space's Lead, the Conversation that its page shows.
 */
export function useSpaceLead(spaceId: string | undefined) {
  return useQuery({
    ...spaceLeadQuery(spaceId ?? ""),
    enabled: Boolean(spaceId),
    retry: false,
  });
}
