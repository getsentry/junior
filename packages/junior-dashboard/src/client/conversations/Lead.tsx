import { leadSchema } from "@sentry/junior/api/schema";
import { useQuery } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import { Link } from "react-router";

import { buttonVariants } from "../components/ui/button";
import { fetchDashboardJson } from "../http";
import { cn } from "../styles";
import { conversationPath } from "./conversationRoutes";

/** Find or make the viewer's Lead, the Conversation that home shows. */
export function useLead(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["dashboard", "lead"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(leadSchema, "/api/lead", signal),
    retry: false,
    // A person's Lead never changes.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Open the viewer's Lead from the narrow home, where the list fills the page. */
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
