import { leadSchema } from "@sentry/junior/api/schema";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router";

import { buttonVariants } from "../components/ui/button";
import { fetchDashboardJson } from "../http";
import { cn } from "../styles";
import { conversationPath } from "../conversations/conversationRoutes";

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
 * Read the Lead's Watches again when its transcript changes, since only its
 * own Turns add or stop them.
 */
export function useLeadWatchRefresh(lastSeq: number | undefined) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (lastSeq === undefined) return;
    void queryClient.invalidateQueries({
      exact: true,
      queryKey: LEAD_QUERY_KEY,
    });
  }, [lastSeq, queryClient]);
}

/** Open the viewer's Lead from the narrow conversation list. */
export function LeadLink() {
  const lead = useLead();
  if (!lead.data) return null;
  return (
    <Link
      className={cn(buttonVariants({ variant: "ghost" }), "shrink-0")}
      to={conversationPath(lead.data.conversationId)}
    >
      <Compass aria-hidden="true" className="size-4" strokeWidth={2} />
      Your Lead
    </Link>
  );
}
