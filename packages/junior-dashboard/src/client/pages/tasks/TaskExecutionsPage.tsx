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
import { InlineError } from "../../components/InlineError";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import type { StatusChipTone } from "../../components/StatusChip";
import { StatusDot } from "../../components/StatusDot";
import {
  selectTimeSeries,
  timeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { conversationPath } from "../../conversations/conversationRoutes";
import {
  formatCompactNumber,
  formatCostSummary,
  formatRuntime,
  formatTime,
  taskPath,
} from "../../format";
import { DashboardApiError } from "../../http";
import { pathWithSearch } from "../../searchParams";
import { cn } from "../../styles";
import { TaskExecutionStatusChart } from "./TaskExecutionStatusChart";

/** Leading conversation column flexes; metric columns stay equal fixed widths. */
const EXECUTION_GRID =
  "grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_5.5rem_auto]";

/** Render one task's terminal executions as a browsable conversation-style list. */
export function TaskExecutionsPage(props: { enabled: boolean }) {
  const { taskId, kind } = useParams();
  const [searchParams] = useSearchParams();
  const taskKind = kind === "scheduled" || kind === "event" ? kind : undefined;
  const query = useTaskExecutionsData(
    props.enabled && Boolean(taskId && taskKind),
    taskKind,
    taskId,
  );
  const backTo = pathWithSearch(
    taskId ? taskPath(taskId) : "/tasks/list",
    searchParams,
  );

  if (!taskId || !taskKind) {
    return <Navigate replace to="/tasks" />;
  }
  if (!query.data && !query.error) {
    return (
      <>
        <PageHeader
          description="Terminal runs for one scheduled or event task."
          title="Task executions"
        />
        <PageContentSkeleton label="Loading task executions" variant="list" />
      </>
    );
  }
  if (query.error || !query.data) {
    return (
      <>
        <PageHeader
          description="Terminal runs for one scheduled or event task."
          title="Task executions"
        />
        <Card padding="md">
          <InlineError>
            {query.error instanceof DashboardApiError &&
            query.error.status === 404
              ? "This task was not found or is not visible to you."
              : "Task executions could not be loaded. Try again."}
          </InlineError>
          <Link
            className="mt-3 inline-flex items-center gap-2 font-mono text-xs text-dashboard-text-muted no-underline hover:text-dashboard-text"
            to={taskId ? taskPath(taskId) : "/tasks/list"}
          >
            <ArrowLeft aria-hidden="true" size={14} />
            Back to tasks
          </Link>
        </Card>
      </>
    );
  }

  return <TaskExecutionsView backTo={backTo} data={query.data} />;
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
    <>
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
        <TaskExecutionStatusChart
          bucketUnit={timeRangeBucketUnit(range)}
          days={selectTimeSeries({
            days: data.executionDays,
            hours: data.executionHours,
            range,
          })}
          range={range}
        />
      ) : null}

      <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 border-b border-dashboard-border-subtle pb-3">
        <p className="m-0 text-sm text-dashboard-text-muted">
          {data.executions.length}{" "}
          {data.executions.length === 1 ? "run" : "runs"}
          <span className="text-dashboard-text-muted/70"> · newest first</span>
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
          <div className="min-w-0 overflow-x-auto">
            <div className="min-w-[36rem]">
              <div
                className={cn(
                  "sticky top-0 z-[1] hidden items-center gap-4 border-b border-dashboard-border-subtle bg-dashboard-overlay-soft px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted md:grid",
                  EXECUTION_GRID,
                )}
                role="row"
              >
                <div>Conversation</div>
                <div>Duration</div>
                <div>Tokens</div>
                <div>Cost</div>
                <div className="sr-only">Status</div>
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
            </div>
          </div>
        </Card>
      )}

      {data.truncated ? (
        <p className="m-0 text-center text-xs text-dashboard-text-muted">
          Showing the 100 most recent executions.
        </p>
      ) : null}
    </>
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
  const costLabel =
    formatCostSummary(
      execution.costUsd === undefined
        ? undefined
        : { total: execution.costUsd },
    ) || "—";
  const durationLabel = formatRuntime(execution.durationMs) || "—";
  const tokensLabel =
    execution.totalTokens === undefined
      ? "—"
      : formatCompactNumber(execution.totalTokens);
  const openConversation = () => {
    if (!execution.conversationId) return;
    navigate(conversationPath(execution.conversationId));
  };

  return (
    <div
      aria-disabled={!execution.conversationId}
      className={cn(
        "group grid min-w-0 items-center gap-4 overflow-hidden border-b border-dashboard-border-subtle px-4 py-3 text-left text-inherit transition-colors last:border-b-0 max-md:grid-cols-1 max-md:gap-y-2 max-md:px-4 max-md:py-3.5 md:grid",
        EXECUTION_GRID,
        execution.conversationId
          ? "cursor-pointer hover:bg-dashboard-fill-soft"
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
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <StatusDot
            className="md:hidden"
            label={execution.status}
            tone={runStatusTone(execution.status)}
          />
          <div className="min-w-0 truncate text-sm font-medium leading-snug text-dashboard-text">
            {title}
          </div>
        </div>
        <div className="mt-1 truncate text-xs leading-relaxed text-dashboard-text-muted">
          {formatRunDate(execution.executedAt)}
        </div>
      </div>
      <MetricCell label="Duration" value={durationLabel} />
      <MetricCell label="Tokens" value={tokensLabel} />
      <MetricCell label="Cost" value={costLabel} />
      <div className="hidden justify-self-center md:block">
        <StatusDot
          label={execution.status}
          tone={runStatusTone(execution.status)}
        />
      </div>
    </div>
  );
}

function MetricCell(props: { label: string; value: string }) {
  return (
    <div className="min-w-0 max-md:flex max-md:items-center max-md:gap-2">
      <div
        aria-hidden="true"
        className="mb-1 hidden font-mono text-2xs uppercase tracking-[0.1em] text-dashboard-text-muted max-md:mb-0 max-md:block"
      >
        {props.label}
      </div>
      <div className="truncate whitespace-nowrap font-mono text-xs text-dashboard-text-muted md:text-sm md:text-dashboard-text">
        <span className="sr-only">{props.label}: </span>
        {props.value}
      </div>
    </div>
  );
}

function runStatusTone(status: TaskExecution["status"]): StatusChipTone {
  if (status === "failed") return "danger";
  if (status === "blocked") return "warning";
  return "success";
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
