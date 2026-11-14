import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CirclePause,
  CircleX,
  LockKeyhole,
  type LucideIcon,
} from "lucide-react";
import { useContext, useState } from "react";
import {
  conversationChildAgentsReportSchema,
  type ConversationChildAgent,
} from "@sentry/junior/api/schema";

import type { StatusChipTone } from "../components/StatusChip";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import {
  formatConversationCostTotal,
  formatRuntime,
  formatTime,
  formatUsageTotal,
} from "../format";
import { fetchDashboardJson } from "../http";
import { conversationSideReadQueryKey } from "./conversationSideReads";
import { conversationPath } from "./conversationRoutes";
import { FeedThreads } from "./feedThreads";
import { cn } from "../styles";
import {
  DetailsCard,
  DetailsList,
  DetailsRow,
  DetailsRowLine,
} from "./DetailsList";
import type { ConversationDrawerTarget } from "./ConversationDrawer";

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
    queryKey: conversationSideReadQueryKey(conversationId, "agents"),
    retry: false,
  });
}

/**
 * List the Threads of one Conversation. Each row opens the Thread page.
 * Archived Threads stay hidden until the reader asks for them.
 */
export function ConversationThreads(props: {
  threads: readonly ConversationChildAgent[];
}) {
  const feedThreads = useContext(FeedThreads);
  const { action, items: threads } = useShowArchived(props.threads);
  return (
    <DetailsCard
      action={action}
      count={threads.length}
      flat
      label="Threads"
      title="Threads"
    >
      {threads.length > 0 ? (
        <DetailsList
          itemKey={(thread) => thread.conversationId}
          items={threads}
          renderItem={(thread) => (
            <ChildAgentRow
              agent={thread}
              // The report title is the invocation title, so the Thread's
              // own title wins. Archived Threads are not in the feed.
              title={feedThreads.get(thread.conversationId)?.displayTitle}
              to={conversationPath(thread.conversationId)}
            />
          )}
        />
      ) : (
        <p className="m-0">Every Thread is archived.</p>
      )}
    </DetailsCard>
  );
}

/**
 * List the Tasks of one Conversation. Tasks are background work, so the list
 * stays short, and a row opens the Task transcript beside this page.
 */
export function ConversationTasks(props: {
  onOpenTask(target: ConversationDrawerTarget): void;
  tasks: readonly ConversationChildAgent[];
}) {
  const { action, items: tasks } = useShowArchived(props.tasks);
  return (
    <DetailsCard
      action={action}
      count={tasks.length}
      flat
      label="Tasks"
      title="Tasks"
    >
      {tasks.length > 0 ? (
        <DetailsList
          itemKey={(task) => task.conversationId}
          items={tasks}
          renderItem={(task) => (
            <ChildAgentRow
              agent={task}
              onOpen={() =>
                props.onOpenTask({
                  conversationId: task.conversationId,
                  ...(task.redacted
                    ? undefined
                    : {
                        ...(task.name ? { agentName: task.name } : undefined),
                        label: task.title ?? task.name,
                      }),
                  status: task.status,
                })
              }
            />
          )}
        />
      ) : (
        <p className="m-0">Every Task is archived.</p>
      )}
    </DetailsCard>
  );
}

/** Hide archived children until the reader asks for them. */
function useShowArchived(children: readonly ConversationChildAgent[]) {
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = children.filter((child) => child.archivedAt).length;
  return {
    action:
      archivedCount > 0 ? (
        <Button
          className="rounded-md px-1.5 py-0.5 text-xs"
          onClick={() => setShowArchived((value) => !value)}
          variant="ghost"
          size="bare"
        >
          {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
        </Button>
      ) : null,
    items: showArchived
      ? children
      : children.filter((child) => !child.archivedAt),
  };
}

const statusIcons: Partial<Record<string, LucideIcon>> = {
  active: CircleDot,
  blocked: CircleAlert,
  completed: CircleCheck,
  error: CircleX,
  failed: CircleX,
  paused: CirclePause,
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
function ChildAgentStatusIcon(props: { archived: boolean; status: string }) {
  const Icon = props.archived
    ? Archive
    : props.status === "running"
      ? Spinner
      : (statusIcons[props.status] ?? Circle);
  return (
    <>
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5",
          props.archived
            ? "text-dashboard-text-faint"
            : statusIconToneClass[subagentStatusTone(props.status)],
        )}
      />
      <span className="sr-only">
        {props.archived ? "archived" : props.status}
      </span>
    </>
  );
}

/**
 * Show one child agent as a dense row: status, title, and run time first,
 * then agent name and cost. The row text is the accessible name, so status,
 * title, and error stay audible. A Thread row links to its page; a Task row
 * opens its transcript.
 */
function ChildAgentRow(props: {
  agent: ConversationChildAgent;
  onOpen?(): void;
  /** The Conversation's own title, when known. It wins over the report title. */
  title?: string | undefined;
  to?: string;
}) {
  const { agent } = props;
  const tone = subagentStatusTone(agent.status);
  const task = agent.task?.trim();
  const headline = props.title ?? agent.title ?? task;
  const kindLabel = agent.kind === "thread" ? "Thread" : "Task";
  const name = agent.redacted
    ? `Private ${kindLabel.toLowerCase()}`
    : agent.name;
  // Totals include this child's own children. Say so, so the row does not
  // read as the work of this child alone.
  const nested = agent.childAgentTotals?.count;
  const meta = [
    headline ? name : "",
    formatUsageTotal(agent.cumulativeUsage),
    formatConversationCostTotal(agent.cumulativeUsage, agent.auxiliaryCosts),
    nested ? `+${nested} nested` : "",
  ].filter(Boolean);

  return (
    <DetailsRow
      icon={
        <ChildAgentStatusIcon
          archived={Boolean(agent.archivedAt)}
          status={agent.status}
        />
      }
      meta={formatRuntime(agent.cumulativeDurationMs)}
      onClick={props.onOpen}
      title={headline ?? name ?? kindLabel}
      to={props.to}
      tooltip={[
        task && task !== headline ? task : "",
        `Updated ${formatTime(agent.updatedAt, {
          dateStyle: "medium",
          timeStyle: "short",
        })}`,
      ]
        .filter(Boolean)
        .join("\n")}
    >
      {meta.length > 0 || agent.redacted ? (
        <DetailsRowLine className="flex items-center gap-1.5">
          {agent.redacted ? (
            <LockKeyhole aria-hidden="true" className="size-3 shrink-0" />
          ) : null}
          <span className="min-w-0 truncate">{meta.join(" · ")}</span>
        </DetailsRowLine>
      ) : null}
      {agent.error ? (
        <DetailsRowLine
          className={cn(
            "line-clamp-2 whitespace-pre-wrap break-words",
            errorToneClass[tone],
          )}
        >
          {agent.error}
        </DetailsRowLine>
      ) : null}
    </DetailsRow>
  );
}
