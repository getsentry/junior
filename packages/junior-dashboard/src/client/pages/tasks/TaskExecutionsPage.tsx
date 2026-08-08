import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  Link,
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import type {
  TaskExecution,
  TaskExecutionList,
} from "@sentry/junior/api/schema";

import { useTaskExecutionsData } from "../../api";
import { LoadingView } from "../../components/LoadingView";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { conversationPath, formatTime } from "../../format";
import { DashboardApiError } from "../../http";
import { pathWithSearch } from "../../searchParams";
import { cn, dashboardContainerClass } from "../../styles";
import { TaskExecutionStatusChart } from "./TaskExecutionStatusChart";

/** Render one task's terminal executions as a browsable conversation-style list. */
export function TaskExecutionsPage(props: { enabled: boolean }) {
  const { taskId, kind } = useParams();
  const [searchParams] = useSearchParams();
  const taskKind =
    kind === "scheduled" || kind === "event" ? kind : undefined;
  const query = useTaskExecutionsData(
    props.enabled && Boolean(taskId && taskKind),
    taskKind,
    taskId,
  );
  const backTo = pathWithSearch(
    taskId ? `/tasks/${encodeURIComponent(taskId)}` : "/tasks",
    searchParams,
  );

  if (!taskId || !taskKind) {
    return <Navigate replace to="/tasks" />;
  }
  if (!query.data && !query.error) {
    return <LoadingView label="Loading task executions" />;
  }
  if (query.error || !query.data) {
    return (
      <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
        <section className="mx-auto grid w-full max-w-4xl gap-5">
          <PageHeader
            description="Terminal runs for one scheduled or event task."
            title="Task executions"
          />
          <Card padding="md">
            <p className="m-0 text-sm text-rose-300">
              {query.error instanceof DashboardApiError && query.error.status === 404
                ? "This task was not found or is not visible to you."
                : "Task executions could not be loaded. Try again."}
            </p>
            <Link
              className="mt-3 inline-flex items-center gap-2 font-mono text-xs text-dashboard-text-muted no-underline hover:text-dashboard-text"
              to="/tasks"
            >
              <ArrowLeft aria-hidden="true" size={14} />
              Back to tasks
            </Link>
          </Card>
        </section>
      </div>
    );
  }

  return (
    <TaskExecutionsView backTo={backTo} data={query.data} />
  );
}

function TaskExecutionsView(props: {
  backTo: string;
  data: TaskExecutionList;
}) {
  const { data } = props;
  const [range, setRange] = useState<TimeRangeDays>(30);
  const counts = useMemo(
    () => countByStatus(data.executions),
    [data.executions],
  );
  const statusCounts = `${counts.completed} completed · ${counts.failed} failed · ${counts.blocked} blocked`;
  const statusSummary = data.truncated
    ? `${data.task.totalRuns} total · loaded runs: ${statusCounts}`
    : `${data.task.totalRuns} total · ${statusCounts}`;

  return (
    <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
      <section className="mx-auto grid w-full max-w-4xl gap-5">
        <div>
          <Link
            className="mb-3 inline-flex items-center gap-2 font-mono text-xs text-dashboard-text-muted no-underline hover:text-dashboard-text"
            to={props.backTo}
          >
            <ArrowLeft aria-hidden="true" size={14} />
            Back to task
          </Link>
          <PageHeader
            description={`${data.task.kind} task · ${data.task.destination.label} · ${statusSummary}`}
            {...(data.executionDays.length > 0
              ? { onRangeChange: setRange, range }
              : {})}
            title={data.task.title}
          />
        </div>

        {data.executionDays.length > 0 ? (
          <TaskExecutionStatusChart days={data.executionDays} range={range} />
        ) : null}

        <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 border-b border-white/[0.07] pb-3">
          <p className="m-0 font-display text-lg text-dashboard-text">
            {data.executions.length}{" "}
            {data.executions.length === 1 ? "run" : "runs"}
          </p>
          <p className="m-0 text-xs text-dashboard-text-muted">
            Newest first. Click a run to open its conversation.
          </p>
        </div>

        {data.executions.length === 0 ? (
          <Card padding="md">
            <p className="m-0 text-sm text-dashboard-text-muted">
              This task has not produced any terminal executions yet.
            </p>
          </Card>
        ) : (
          <Card>
            <div
              className="sticky top-0 z-[1] hidden grid-cols-[minmax(13rem,1.7fr)_minmax(10rem,1fr)] items-center gap-3 border-b border-white/[0.06] bg-black/25 px-3 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted md:grid"
              role="row"
            >
              <div>Conversation</div>
              <div className="justify-self-end">Status</div>
            </div>
            <div className="min-w-0" role="table">
              {data.executions.map((execution) => (
                <ExecutionRow
                  execution={execution}
                  fallbackTitle={data.task.title}
                  key={execution.executionId}
                />
              ))}
            </div>
          </Card>
        )}

        {data.truncated ? (
          <p className="m-0 text-center text-xs text-dashboard-text-muted">
            Showing the 100 most recent executions.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function ExecutionRow(props: {
  execution: TaskExecution;
  fallbackTitle: string;
}) {
  const { execution, fallbackTitle } = props;
  const navigate = useNavigate();
  const title =
    execution.title?.trim() ||
    (execution.conversationId ? fallbackTitle : "No conversation");
  const subtitle = [
    formatRunDate(execution.executedAt),
    execution.conversationId ?? "not linked",
  ].join(" · ");
  const openConversation = () => {
    if (!execution.conversationId) return;
    navigate(conversationPath(execution.conversationId));
  };

  return (
    <div
      aria-disabled={!execution.conversationId}
      className={cn(
        "group grid min-w-0 grid-cols-[minmax(13rem,1.7fr)_minmax(10rem,1fr)] items-center gap-3 overflow-hidden border-b border-b-white/[0.055] px-3 py-3 text-left text-inherit transition-colors max-md:grid-cols-1 max-md:px-4 max-md:py-4",
        execution.conversationId
          ? "cursor-pointer hover:bg-white/[0.035]"
          : "cursor-default opacity-80",
      )}
      onClick={openConversation}
      onKeyDown={(event) => {
        if (!execution.conversationId) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openConversation();
        }
      }}
      role={execution.conversationId ? "link" : "row"}
      tabIndex={execution.conversationId ? 0 : undefined}
    >
      <div className="min-w-0">
        <div className="min-w-0 truncate text-base font-bold leading-tight text-dashboard-text">
          {title}
        </div>
        <div className="mt-1 break-words text-sm leading-relaxed text-dashboard-text-muted md:truncate">
          {subtitle}
        </div>
      </div>
      <div className="grid min-w-0 justify-items-end gap-1 text-right max-md:justify-items-start max-md:text-left">
        <StatusBadge status={execution.status} />
      </div>
    </div>
  );
}

function StatusBadge(props: { status: TaskExecution["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-1 font-mono text-xs uppercase tracking-[0.1em]",
        props.status === "completed" &&
          "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
        props.status === "failed" &&
          "border-rose-400/25 bg-rose-400/10 text-rose-200",
        props.status === "blocked" &&
          "border-amber-400/25 bg-amber-400/10 text-amber-100",
      )}
    >
      {props.status}
    </span>
  );
}

function countByStatus(executions: TaskExecution[]) {
  return executions.reduce(
    (counts, execution) => {
      counts[execution.status] += 1;
      return counts;
    },
    { blocked: 0, completed: 0, failed: 0 },
  );
}

function formatRunDate(value: string): string {
  return formatTime(value, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZoneName: "short",
    year: "numeric",
  });
}
