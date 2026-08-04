import { type ReactNode, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskSummary } from "@sentry/junior/api/schema";
import { Link } from "react-router";
import {
  CalendarClock,
  Globe2,
  MapPin,
  Search,
  Trash2,
  UserRound,
} from "lucide-react";
import { useTasksData } from "../../api";
import { Button, ToggleButton } from "../../components/Button";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { deleteDashboardResource } from "../../http";
import { formatTime, peoplePath } from "../../format";
import { cn, dashboardContainerClass } from "../../styles";

type TaskFilter = "all" | TaskSummary["kind"];
type TaskScope = "mine" | "public";

function formatDate(value: string): string {
  return formatTime(value, {
    dateStyle: "medium",
    timeStyle: "short",
  });
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

function taskMatches(task: TaskSummary, search: string): boolean {
  const haystack = [
    task.createdBy,
    task.destination.channelId,
    task.destination.label,
    task.destination.teamId,
    task.instruction,
    task.kind,
    task.kind === "scheduled" ? task.schedule : task.resource,
    ...(task.kind === "event" ? [task.source] : []),
    ...(task.kind === "event" ? task.events : []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}

/** Render viewer-owned and public-workspace tasks in one native view. */
export function TasksPage(props: { enabled: boolean }) {
  const query = useTasksData(props.enabled);
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [scope, setScope] = useState<TaskScope>("mine");
  const [searchText, setSearchText] = useState("");
  const search = searchText.trim().toLowerCase();
  const tasks = query.data?.tasks ?? [];
  const mineCount = tasks.filter((task) => task.ownedByViewer).length;
  const publicCount = tasks.filter(
    (task) => task.destination.visibility === "public",
  ).length;
  const scopedTasks = useMemo(
    () =>
      tasks.filter((task) =>
        scope === "mine"
          ? task.ownedByViewer
          : task.destination.visibility === "public",
      ),
    [scope, tasks],
  );
  const visibleTasks = useMemo(
    () =>
      scopedTasks.filter(
        (task) =>
          (filter === "all" || task.kind === filter) &&
          (!search || taskMatches(task, search)),
      ),
    [filter, scopedTasks, search],
  );
  const deletion = useMutation({
    mutationFn: async (task: TaskSummary) => {
      await deleteDashboardResource(
        `/api/tasks/${task.kind}/${encodeURIComponent(task.id)}`,
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboard", "tasks"] });
    },
  });

  if (!query.data && !query.error) {
    return <LoadingView label="Loading tasks" />;
  }

  return (
    <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
      <section className="mx-auto grid w-full max-w-6xl gap-5">
        <PageHeader
          description="Scheduled and event-driven work across your Slack destinations."
          eyebrow="Automation"
          title="Tasks"
        />
        <Card className="grid gap-4 p-4 lg:grid-cols-[auto_auto_minmax(16rem,1fr)] lg:items-end">
          <TaskFilterGroup label="Scope">
            <ToggleButton
              className="inline-flex items-center gap-1.5"
              onClick={() => setScope("mine")}
              pressed={scope === "mine"}
              variant="pill"
            >
              <UserRound aria-hidden="true" size={13} />
              Mine <span className="opacity-65">{mineCount}</span>
            </ToggleButton>
            <ToggleButton
              className="inline-flex items-center gap-1.5"
              onClick={() => setScope("public")}
              pressed={scope === "public"}
              variant="pill"
            >
              <Globe2 aria-hidden="true" size={13} />
              Public <span className="opacity-65">{publicCount}</span>
            </ToggleButton>
          </TaskFilterGroup>
          <TaskFilterGroup label="Type">
            {(["all", "scheduled", "event"] as const).map((kind) => (
              <ToggleButton
                key={kind}
                onClick={() => setFilter(kind)}
                pressed={filter === kind}
                variant="pill"
              >
                {kind}
              </ToggleButton>
            ))}
          </TaskFilterGroup>
          <label className="relative min-w-0">
            <span className="mb-2 block font-mono text-[0.62rem] uppercase tracking-[0.12em] text-dashboard-text-muted">
              Search
            </span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute bottom-[0.68rem] left-3 text-dashboard-text-muted"
              size={15}
            />
            <input
              className="h-9 w-full rounded border border-white/15 bg-black pr-3 pl-9 text-sm text-dashboard-text placeholder:text-dashboard-text-muted focus:border-cyan-300/50 focus:outline-none"
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Instruction, location, or creator"
              type="search"
              value={searchText}
            />
          </label>
        </Card>
        <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 border-b border-white/[0.07] pb-3">
          <p className="m-0 font-display text-lg text-dashboard-text">
            {visibleTasks.length} {visibleTasks.length === 1 ? "task" : "tasks"}
          </p>
          <p className="m-0 text-xs text-dashboard-text-muted">
            {scope === "mine"
              ? "Tasks you created, including private destinations."
              : "All tasks assigned to public destinations in your linked workspaces."}
          </p>
        </div>
        {query.error ? (
          <Card padding="md">
            <p className="m-0 text-sm text-rose-300">
              Tasks could not be loaded. Try again.
            </p>
          </Card>
        ) : visibleTasks.length === 0 ? (
          <Card padding="md">
            <p className="m-0 text-sm text-dashboard-text-muted">
              {emptyText({ filter, mineCount, publicCount, scope, search })}
            </p>
          </Card>
        ) : (
          <Card>
            <div className="divide-y divide-white/[0.07]" role="list">
              {visibleTasks.map((task) => (
                <TaskRow
                  deleting={
                    deletion.isPending && deletion.variables?.id === task.id
                  }
                  key={`${task.kind}:${task.id}`}
                  onDelete={() => {
                    if (window.confirm(`Delete this ${task.kind} task?`)) {
                      deletion.mutate(task);
                    }
                  }}
                  task={task}
                />
              ))}
            </div>
          </Card>
        )}
        {query.data?.truncated ? (
          <p className="m-0 text-center text-xs text-dashboard-text-muted">
            Showing up to 100 recent tasks in each scope.
          </p>
        ) : null}
        {deletion.error ? (
          <p className="m-0 text-center text-sm text-rose-300">
            The task could not be deleted. Try again.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function emptyText(input: {
  filter: TaskFilter;
  mineCount: number;
  publicCount: number;
  scope: TaskScope;
  search: string;
}): string {
  if (input.search || input.filter !== "all") {
    return "No tasks matched these filters.";
  }
  if (input.scope === "mine" && input.mineCount === 0) {
    return "You have not created any tasks.";
  }
  if (input.scope === "public" && input.publicCount === 0) {
    return "No tasks are assigned to public destinations in your linked workspaces.";
  }
  return "No tasks are available.";
}

function TaskFilterGroup(props: { children: ReactNode; label: string }) {
  return (
    <div>
      <div className="mb-2 font-mono text-[0.62rem] uppercase tracking-[0.12em] text-dashboard-text-muted">
        {props.label}
      </div>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={props.label}
      >
        {props.children}
      </div>
    </div>
  );
}

function TaskRow(props: {
  deleting: boolean;
  onDelete(): void;
  task: TaskSummary;
}) {
  const { task } = props;
  return (
    <article
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-4 p-4 sm:p-5"
      role="listitem"
    >
      <TaskSourceMark task={task} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <TaskTag>{task.kind}</TaskTag>
          {task.kind === "scheduled" ? (
            <TaskTag tone={task.status === "active" ? "success" : "warning"}>
              {task.status}
            </TaskTag>
          ) : (
            <TaskTag tone={task.triggerAvailable ? "success" : "warning"}>
              {task.triggerAvailable ? "trigger ready" : "trigger unavailable"}
            </TaskTag>
          )}
        </div>
        <h3 className="mt-2 mb-0 font-display text-base font-medium text-dashboard-text sm:text-lg">
          {task.instruction}
        </h3>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <MapPin aria-hidden="true" className="text-cyan-300/70" size={14} />
          <span className="font-medium text-dashboard-text">
            {task.destination.label}
          </span>
          {task.destination.visibility === "public" ? (
            <span className="text-xs text-dashboard-text-muted">· Public</span>
          ) : null}
        </div>
        <div className="mt-3 text-sm text-dashboard-text-muted">
          {task.kind === "scheduled" ? (
            <>
              <span className="text-dashboard-text">{task.schedule}</span>
              <span className="mx-2 opacity-45">·</span>
              {task.nextRunAt
                ? `Next run ${formatRunDate(task.nextRunAt)}`
                : "No next run"}
            </>
          ) : (
            <>
              <span className="text-dashboard-text">{task.resource}</span>
              <span className="mx-2 opacity-45">·</span>
              {task.events.join(", ")}
            </>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-2 text-xs text-dashboard-text-muted">
          <span>
            Created by{" "}
            {task.createdByEmail ? (
              <Link
                className="font-semibold text-dashboard-text underline decoration-white/20 underline-offset-2 transition-colors hover:decoration-white/60"
                to={peoplePath(task.createdByEmail)}
              >
                {task.ownedByViewer ? "you" : task.createdBy}
              </Link>
            ) : task.ownedByViewer ? (
              "you"
            ) : (
              task.createdBy
            )}
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatDate(task.createdAt)}</span>
        </div>
      </div>
      {task.ownedByViewer ? (
        <Button
          aria-label={`Delete: ${task.instruction}`}
          className="self-start justify-self-end"
          disabled={props.deleting}
          onClick={props.onDelete}
          size="icon"
          title="Delete task"
        >
          <Trash2 aria-hidden="true" size={15} />
        </Button>
      ) : null}
    </article>
  );
}

function TaskSourceMark(props: { task: TaskSummary }) {
  const { task } = props;
  if (task.kind === "scheduled") {
    return (
      <div
        aria-label="Scheduled task"
        className="grid size-10 shrink-0 place-items-center rounded border border-white/[0.08] bg-white/[0.03] text-cyan-300/75"
        role="img"
        title="Scheduled task"
      >
        <CalendarClock aria-hidden="true" size={17} />
      </div>
    );
  }
  const source = task.source.trim();
  const sourceKey = source.toLowerCase();
  const isGitHub = sourceKey === "github";
  const sourceLabel = isGitHub
    ? "GitHub"
    : sourceKey === "pagerduty"
      ? "PagerDuty"
      : source;
  const sourceMark =
    sourceKey === "pagerduty" ? "PD" : source.slice(0, 2).toUpperCase();
  return (
    <div
      aria-label={`${sourceLabel} event task`}
      className="grid size-10 shrink-0 place-items-center rounded border border-white/[0.08] bg-white/[0.03] text-cyan-300/75"
      role="img"
      title={`${sourceLabel} event task`}
    >
      {isGitHub ? (
        <GitHubMark />
      ) : (
        <span className="font-mono text-[0.65rem] font-semibold uppercase tracking-[0.08em]">
          {sourceMark}
        </span>
      )}
    </div>
  );
}

function GitHubMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-[18px]"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.793 1.23 1.1-.306 2.28-.459 3.45-.465 1.17.006 2.35.159 3.45.465 2.79-1.552 3.795-1.23 3.795-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.435.375.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function TaskTag(props: {
  children: ReactNode;
  tone?: "default" | "success" | "warning";
}) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 font-mono text-[0.62rem] uppercase tracking-[0.08em]",
        props.tone === "success"
          ? "border-emerald-300/20 bg-emerald-300/[0.06] text-emerald-200/80"
          : props.tone === "warning"
            ? "border-amber-300/20 bg-amber-300/[0.06] text-amber-200/80"
            : "border-white/10 bg-white/[0.03] text-dashboard-text-muted",
      )}
    >
      {props.children}
    </span>
  );
}
