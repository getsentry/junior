import { useNavigate } from "react-router";
import type { TaskRun } from "@sentry/junior/api/schema";

import { useTaskRunsData } from "../../api";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { conversationPath, formatTime } from "../../format";
import { cn, dashboardContainerClass } from "../../styles";

/** Render newest runs across every task visible to the signed-in viewer. */
export function TaskRunsPage(props: { enabled: boolean }) {
  const query = useTaskRunsData(props.enabled);

  if (!query.data && !query.error) {
    return <LoadingView label="Loading task runs" />;
  }

  return (
    <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
      <section className="mx-auto grid w-full max-w-5xl gap-5">
        <PageHeader
          description="Newest runs across your tasks and tasks in public destinations."
          title="Runs"
        />
        {query.error ? (
          <Card padding="md">
            <p className="m-0 text-sm text-rose-300">
              Task runs could not be loaded. Try again.
            </p>
          </Card>
        ) : query.data?.runs.length === 0 ? (
          <Card padding="md">
            <p className="m-0 text-sm text-dashboard-text-muted">
              No visible tasks have run yet.
            </p>
          </Card>
        ) : (
          <Card>
            <div
              className="sticky top-0 z-[1] hidden grid-cols-[minmax(13rem,1.7fr)_minmax(11rem,1fr)_auto] items-center gap-3 border-b border-white/[0.06] bg-black/25 px-3 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted md:grid"
              role="row"
            >
              <div>Run</div>
              <div>Task</div>
              <div>Status</div>
            </div>
            <div className="min-w-0" role="table">
              {query.data?.runs.map((run) => (
                <TaskRunRow key={`${run.kind}:${run.executionId}`} run={run} />
              ))}
            </div>
          </Card>
        )}
        {query.data?.truncated ? (
          <p className="m-0 text-center text-xs text-dashboard-text-muted">
            Showing the 100 most recent runs.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function TaskRunRow(props: { run: TaskRun }) {
  const { run } = props;
  const navigate = useNavigate();
  const title =
    run.title?.trim() ||
    (run.conversationId ? run.taskTitle : "No conversation");
  const openConversation = () => {
    if (run.conversationId) navigate(conversationPath(run.conversationId));
  };

  return (
    <div
      aria-disabled={!run.conversationId}
      className={cn(
        "group grid min-w-0 grid-cols-[minmax(13rem,1.7fr)_minmax(11rem,1fr)_auto] items-center gap-3 overflow-hidden border-b border-b-white/[0.055] px-3 py-3 text-left text-inherit transition-colors max-md:grid-cols-1 max-md:px-4 max-md:py-4",
        run.conversationId
          ? "cursor-pointer hover:bg-white/[0.035]"
          : "cursor-default opacity-80",
      )}
      onClick={openConversation}
      onKeyDown={(event) => {
        if (!run.conversationId) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openConversation();
        }
      }}
      role={run.conversationId ? "link" : "row"}
      tabIndex={run.conversationId ? 0 : undefined}
    >
      <div className="min-w-0">
        <div className="truncate text-base font-bold leading-tight text-dashboard-text">
          {title}
        </div>
        <div className="mt-1 truncate text-sm text-dashboard-text-muted">
          {formatRunDate(run.executedAt)}
        </div>
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-dashboard-text">
          {run.taskTitle}
        </div>
        <div className="mt-1 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
          {run.kind}
        </div>
      </div>
      <span
        className={cn(
          "inline-flex w-fit items-center rounded border px-2 py-1 font-mono text-xs uppercase tracking-[0.1em]",
          run.status === "completed" &&
            "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
          run.status === "failed" &&
            "border-rose-400/25 bg-rose-400/10 text-rose-200",
          run.status === "blocked" &&
            "border-amber-400/25 bg-amber-400/10 text-amber-100",
        )}
      >
        {run.status}
      </span>
    </div>
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
