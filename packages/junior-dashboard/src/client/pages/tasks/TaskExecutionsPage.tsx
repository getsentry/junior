import { useMemo } from "react";
import { ArrowLeft, CircleCheck, CircleDashed, CircleX } from "lucide-react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import type {
  TaskExecution,
  TaskExecutionList,
} from "@sentry/junior/api/schema";

import { useTaskExecutionsData } from "../../api";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { conversationPath, formatTime } from "../../format";
import { DashboardApiError } from "../../http";
import { pathWithSearch } from "../../searchParams";
import { cn, dashboardContainerClass } from "../../styles";
import { TranscriptText } from "../../conversations/TranscriptText";

/** Render one task's terminal executions as a browsable list. */
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
  const counts = useMemo(() => countByStatus(data.executions), [data.executions]);

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
            description={`${data.task.kind} task · ${data.task.destination.label}`}
            title="Task executions"
          />
        </div>

        <Card className="grid gap-3 p-4">
          <div className="font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
            Instruction
          </div>
          <TranscriptText text={data.task.instruction} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-dashboard-text-muted">
            <span>{data.task.totalRuns} total</span>
            <span>{counts.completed} completed</span>
            <span>{counts.failed} failed</span>
            <span>{counts.blocked} blocked</span>
          </div>
        </Card>

        <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 border-b border-white/[0.07] pb-3">
          <p className="m-0 font-display text-lg text-dashboard-text">
            {data.executions.length}{" "}
            {data.executions.length === 1 ? "execution" : "executions"}
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
            <div className="divide-y divide-white/[0.07]" role="list">
              {data.executions.map((execution) => (
                <ExecutionRow
                  execution={execution}
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

function ExecutionRow(props: { execution: TaskExecution }) {
  const { execution } = props;
  const content = (
    <div className="flex min-w-0 items-center gap-3 px-4 py-3">
      <StatusMark status={execution.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-base font-medium text-dashboard-text capitalize">
          {execution.status}
        </div>
        <div className="mt-1 truncate font-mono text-xs text-dashboard-text-muted">
          {formatRunDate(execution.executedAt)}
          {execution.conversationId ? " · open conversation" : " · no conversation"}
        </div>
      </div>
    </div>
  );

  if (!execution.conversationId) {
    return (
      <article className="opacity-80" role="listitem">
        {content}
      </article>
    );
  }

  return (
    <article role="listitem">
      <Link
        className="block text-inherit no-underline transition-colors hover:bg-white/[0.03]"
        to={conversationPath(execution.conversationId)}
      >
        {content}
      </Link>
    </article>
  );
}

function StatusMark(props: { status: TaskExecution["status"] }) {
  const Icon =
    props.status === "completed"
      ? CircleCheck
      : props.status === "failed"
        ? CircleX
        : CircleDashed;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded border border-white/[0.08] bg-white/[0.03]",
        props.status === "completed" && "text-emerald-300/80",
        props.status === "failed" && "text-rose-300/85",
        props.status === "blocked" && "text-amber-300/80",
      )}
    >
      <Icon size={16} />
    </div>
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
