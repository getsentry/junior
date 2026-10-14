import { useQuery } from "@tanstack/react-query";
import { Bot, CircleAlert, LockKeyhole } from "lucide-react";
import { Link } from "react-router";
import {
  conversationChildAgentsReportSchema,
  type ConversationChildAgent,
} from "@sentry/junior/api/schema";

import { StatusChip, type StatusChipTone } from "../components/StatusChip";
import {
  formatConversationCostTotal,
  formatRelativeTime,
  formatRuntime,
  formatTime,
  formatUsageTotal,
} from "../format";
import { fetchDashboardJson } from "../http";
import { cn } from "../styles";
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

const errorToneClass: Partial<Record<StatusChipTone, string>> = {
  danger: "text-rose-200/85",
  warning: "text-amber-200/85",
};

/** Load the child agents of one Conversation with runtime status. */
export function useConversationChildAgents(conversationId: string) {
  return useQuery({
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationChildAgentsReportSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/agents`,
        signal,
      ),
    queryKey: ["conversation", conversationId, "agents"],
    retry: false,
  });
}

/** Show the child agents of one Conversation with runtime status. */
export function ConversationChildAgents(props: {
  conversationId: string;
  /** Called before a child link leaves the current Conversation. */
  onNavigate(): void;
}) {
  const query = useConversationChildAgents(props.conversationId);

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
    <ol aria-label="Subagents" className="m-0 grid list-none gap-2 p-0">
      {query.data.agents.map((agent) => (
        <li key={agent.conversationId}>
          <ChildAgentRow agent={agent} onNavigate={props.onNavigate} />
        </li>
      ))}
    </ol>
  );
}

/**
 * Lead with what the child agent was asked to do, then its state, then what
 * it cost. The stats use the same terms as Conversation rows.
 */
function ChildAgentRow(props: {
  agent: ConversationChildAgent;
  onNavigate(): void;
}) {
  const { agent } = props;
  const tone = statusTone[agent.status];
  const task = agent.task?.trim();
  const headline = agent.title ?? task;
  // A title is often a short form of the task. Skip the task when it adds nothing.
  const detail = agent.title && task && task !== agent.title ? task : undefined;
  const runtime = formatRuntime(agent.cumulativeDurationMs);
  const stats = [
    formatUsageTotal(agent.cumulativeUsage),
    formatConversationCostTotal(agent.cumulativeUsage, agent.auxiliaryCosts),
    runtime ? `${runtime} runtime` : "",
  ].filter(Boolean);

  return (
    <Link
      className="grid min-w-0 gap-1.5 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface px-3 py-2.5 text-inherit no-underline transition-colors duration-200 hover:border-dashboard-border-emphasis hover:bg-dashboard-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
      onClick={props.onNavigate}
      to={conversationPath(agent.conversationId)}
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {agent.redacted ? (
          <span className="flex min-w-0 items-center gap-1.5 text-dashboard-text-muted">
            <LockKeyhole aria-hidden="true" className="size-3 shrink-0" />
            Private subagent
          </span>
        ) : (
          <span className="min-w-0 truncate font-mono text-dashboard-text-muted">
            {agent.name ?? "subagent"}
          </span>
        )}
        <StatusChip className="ml-auto shrink-0" size="compact" tone={tone}>
          {agent.status}
        </StatusChip>
        <time
          className="shrink-0 text-dashboard-text-faint"
          dateTime={agent.updatedAt}
          title={`Updated ${formatTime(agent.updatedAt, {
            dateStyle: "medium",
            timeStyle: "short",
          })}`}
        >
          {formatRelativeTime(agent.updatedAt)}
        </time>
      </div>
      {headline ? (
        <p className="m-0 line-clamp-2 break-words text-sm font-semibold leading-snug text-dashboard-text">
          {headline}
        </p>
      ) : null}
      {detail ? (
        <p className="m-0 line-clamp-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-dashboard-text-muted">
          {detail}
        </p>
      ) : null}
      {agent.error ? (
        <p
          className={cn(
            "m-0 flex min-w-0 items-start gap-1.5 text-xs leading-relaxed",
            errorToneClass[tone] ?? "text-dashboard-text-muted",
          )}
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
          <span className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words">
            {agent.error}
          </span>
        </p>
      ) : null}
      {stats.length > 0 ? (
        <p className="m-0 font-mono text-xs tabular-nums text-dashboard-text-muted">
          {stats.join(" · ")}
        </p>
      ) : null}
    </Link>
  );
}
