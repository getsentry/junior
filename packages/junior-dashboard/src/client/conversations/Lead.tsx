import { leadSchema } from "@sentry/junior/api/schema";
import { useQuery } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import { Link, Navigate } from "react-router";

import { LoadingView } from "../components/LoadingView";
import { buttonVariants } from "../components/ui/button";
import { fetchDashboardJson } from "../http";
import { cn } from "../styles";
import { ConversationWorkspaceLoading } from "./ConversationWorkspaceLoading";
import { conversationPath } from "./conversationRoutes";

/** The route that opens the viewer's Lead. */
export const LEAD_PATH = "/lead";

/**
 * Link home to the viewer's Lead. The Lead is made on first open, so home
 * sends no request for it.
 */
export function LeadLink(props: { className?: string }) {
  return (
    <Link
      className={cn(
        buttonVariants({ variant: "ghost" }),
        "shrink-0",
        props.className,
      )}
      to={LEAD_PATH}
    >
      <Compass aria-hidden="true" className="size-4" strokeWidth={2} />
      Your Lead
    </Link>
  );
}

/** Find or make the viewer's Lead, then show it as a Conversation. */
export function OpenLead() {
  const lead = useQuery({
    queryKey: ["dashboard", "lead"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(leadSchema, "/api/lead", signal),
    // A person's Lead never changes.
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (lead.data) {
    return <Navigate replace to={conversationPath(lead.data.conversationId)} />;
  }
  return lead.error ? (
    <LoadingView label={lead.error.message} />
  ) : (
    <ConversationWorkspaceLoading detail />
  );
}
