import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { Link } from "react-router";
import {
  conversationChildAgentsReportSchema,
  type ConversationChildAgent,
} from "@sentry/junior/api/schema";

import { StatusChip, type StatusChipTone } from "../components/StatusChip";
import { formatMessageTimestamp } from "../format";
import { fetchDashboardJson } from "../http";
import { conversationPath } from "./conversationRoutes";

const statusTone: Record<ConversationChildAgent["status"], StatusChipTone> = {
  blocked: "warning",
  completed: "success",
  failed: "danger",
  paused: "info",
  pending: "neutral",
  running: "info",
  stopped: "neutral",
};

/** Load and show the child agents of one Conversation with runtime status. */
export function ConversationChildAgents(props: {
  conversationId: string;
  /** Called before a child link leaves the current Conversation. */
  onNavigate(): void;
}) {
  const query = useQuery({
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationChildAgentsReportSchema,
        `/api/conversations/${encodeURIComponent(props.conversationId)}/agents`,
        signal,
      ),
    queryKey: ["conversation", props.conversationId, "agents"],
    retry: false,
  });

  if (query.isPending) {
    return (
      <p className="m-0 text-sm text-dashboard-text-muted" role="status">
        Loading subagents…
      </p>
    );
  }
  if (query.error) {
    return (
      <p className="m-0 text-sm text-red-300/80">
        Could not load subagents from this Conversation.
      </p>
    );
  }
  if (query.data.agents.length === 0) {
    return (
      <div className="grid justify-items-center gap-2 py-10 text-center text-dashboard-text-muted">
        <Bot aria-hidden="true" className="size-5 opacity-60" />
        <p className="m-0 text-sm">No subagents were started.</p>
      </div>
    );
  }

  return (
    <ol aria-label="Subagents" className="m-0 grid list-none gap-3 p-0">
      {query.data.agents.map((agent) => (
        <li
          className="grid gap-2 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface px-3 py-3"
          key={agent.conversationId}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Link
              className="min-w-0 truncate font-mono text-xs font-semibold text-dashboard-text no-underline hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
              onClick={props.onNavigate}
              to={conversationPath(agent.conversationId)}
            >
              {agent.redacted ? "Private subagent" : (agent.name ?? "agent")}
            </Link>
            <StatusChip
              className="ml-auto"
              size="compact"
              tone={statusTone[agent.status]}
            >
              {agent.status}
            </StatusChip>
          </div>
          {agent.task ? (
            <p className="m-0 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-dashboard-text">
              {agent.task}
            </p>
          ) : null}
          {agent.error ? (
            <p className="m-0 whitespace-pre-wrap break-words text-xs leading-relaxed text-dashboard-text-muted">
              {agent.error}
            </p>
          ) : null}
          <time
            className="font-mono text-xs text-dashboard-text-muted"
            dateTime={agent.updatedAt}
          >
            {formatMessageTimestamp(Date.parse(agent.updatedAt), true)}
          </time>
        </li>
      ))}
    </ol>
  );
}
