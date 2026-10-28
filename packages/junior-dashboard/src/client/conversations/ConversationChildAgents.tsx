import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CirclePause,
  CircleX,
  LoaderCircle,
  LockKeyhole,
  type LucideIcon,
} from "lucide-react";
import {
  conversationChildAgentsReportSchema,
  type ConversationChildAgent,
} from "@sentry/junior/api/schema";

import type { StatusChipTone } from "../components/StatusChip";
import {
  formatConversationCostTotal,
  formatRuntime,
  formatTime,
  formatUsageTotal,
} from "../format";
import { fetchDashboardJson } from "../http";
import { cn } from "../styles";
import type { SubagentTranscriptTarget } from "./SubagentTranscriptDrawer";

const statusTones: Partial<Record<string, StatusChipTone>> = {
  active: "info",
  blocked: "warning",
  completed: "success",
  error: "danger",
  failed: "danger",
  paused: "info",
  running: "info",
};

/** Pick the status tone for a child agent, its transcript row, or its detail. */
export function subagentStatusTone(status: string): StatusChipTone {
  return statusTones[status] ?? "neutral";
}

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

/**
 * Show the child agents of one Conversation with runtime status. A row opens
 * that child's transcript.
 */
export function ConversationChildAgents(props: {
  conversationId: string;
  onOpenAgent(target: SubagentTranscriptTarget): void;
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
    <ol
      aria-label="Subagents"
      className="m-0 grid list-none gap-px overflow-hidden rounded-lg border border-dashboard-border-subtle bg-dashboard-border-subtle p-0"
    >
      {query.data.agents.map((agent) => (
        <li className="bg-dashboard-surface-panel" key={agent.conversationId}>
          <ChildAgentRow agent={agent} onOpen={props.onOpenAgent} />
        </li>
      ))}
    </ol>
  );
}

const statusIcons: Partial<Record<string, LucideIcon>> = {
  active: CircleDot,
  blocked: CircleAlert,
  completed: CircleCheck,
  error: CircleX,
  failed: CircleX,
  paused: CirclePause,
  running: LoaderCircle,
};

const statusIconToneClass: Record<StatusChipTone, string> = {
  accent: "text-violet-300",
  danger: "text-rose-300",
  info: "text-cyan-300",
  neutral: "text-dashboard-text-faint",
  success: "text-emerald-300",
  warning: "text-amber-300",
};

/** Mark a child agent status with one icon and an audible label. */
function ChildAgentStatusIcon(props: { status: string }) {
  const Icon = statusIcons[props.status] ?? Circle;
  return (
    <span className="mt-px grid size-4 shrink-0 place-items-center">
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5",
          statusIconToneClass[subagentStatusTone(props.status)],
          props.status === "running" &&
            "animate-spin motion-reduce:animate-none",
        )}
      />
      <span className="sr-only">{props.status}</span>
    </span>
  );
}

/**
 * Show one child agent as a dense row: status, task title, and run time first,
 * then agent name and cost. The row text is the accessible name, so status,
 * title, and error stay audible.
 */
function ChildAgentRow(props: {
  agent: ConversationChildAgent;
  onOpen(target: SubagentTranscriptTarget): void;
}) {
  const { agent } = props;
  const tone = subagentStatusTone(agent.status);
  const task = agent.task?.trim();
  const headline = agent.title ?? task;
  const runtime = formatRuntime(agent.cumulativeDurationMs);
  const name = agent.redacted ? "Private subagent" : (agent.name ?? "subagent");
  // Totals include this subagent's own subagents. Say so, so the row does not
  // read as the work of this subagent alone.
  const nested = agent.childAgentTotals?.count;
  const meta = [
    formatUsageTotal(agent.cumulativeUsage),
    formatConversationCostTotal(agent.cumulativeUsage, agent.auxiliaryCosts),
    nested ? `+${nested} nested` : "",
  ].filter(Boolean);

  return (
    <button
      className="grid w-full min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-0.5 px-3 py-2.5 text-left text-inherit transition-colors hover:bg-dashboard-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
      onClick={() =>
        props.onOpen({
          conversationId: agent.conversationId,
          ...(agent.redacted
            ? undefined
            : {
                ...(agent.name ? { agentName: agent.name } : undefined),
                label: agent.title ?? agent.name,
              }),
          status: agent.status,
        })
      }
      title={[
        task && task !== headline ? task : "",
        `Updated ${formatTime(agent.updatedAt, {
          dateStyle: "medium",
          timeStyle: "short",
        })}`,
      ]
        .filter(Boolean)
        .join("\n")}
      type="button"
    >
      <ChildAgentStatusIcon status={agent.status} />
      <span className="min-w-0 truncate text-sm font-medium leading-5 text-dashboard-text">
        {headline ?? name}
      </span>
      <span className="shrink-0 text-xs leading-5 tabular-nums text-dashboard-text-muted">
        {runtime}
      </span>
      <span className="col-start-2 col-end-4 flex min-w-0 items-center gap-1.5 text-xs leading-4 text-dashboard-text-muted">
        {agent.redacted ? (
          <LockKeyhole aria-hidden="true" className="size-3 shrink-0" />
        ) : null}
        <span className="min-w-0 truncate">
          {[headline ? name : "", ...meta].filter(Boolean).join(" · ")}
        </span>
      </span>
      {agent.error ? (
        <span
          className={cn(
            "col-start-2 col-end-4 line-clamp-2 min-w-0 whitespace-pre-wrap break-words pt-0.5 text-xs leading-4",
            errorToneClass[tone] ?? "text-dashboard-text-muted",
          )}
        >
          {agent.error}
        </span>
      ) : null}
    </button>
  );
}
