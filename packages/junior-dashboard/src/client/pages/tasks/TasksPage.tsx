import { type ReactNode, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskSummary } from "@sentry/junior/api/schema";
import {
  CalendarClock,
  Globe2,
  MapPin,
  Radio,
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
import { cn, dashboardContainerClass } from "../../styles";

type TaskFilter = "all" | TaskSummary["kind"];
type TaskScope = "mine" | "public";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
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
            Showing the 100 most recent tasks available to you.
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
  const Icon = task.kind === "scheduled" ? CalendarClock : Radio;
  return (
    <article
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-4 p-4 sm:p-5"
      role="listitem"
    >
      <div className="grid size-10 shrink-0 place-items-center rounded border border-white/[0.08] bg-white/[0.03] text-cyan-300/75">
        <Icon aria-hidden="true" size={17} />
      </div>
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
          <span className="text-dashboard-text-muted">Assigned to</span>
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
                ? `Next run ${formatDate(task.nextRunAt)}`
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
          <span>Created by {task.ownedByViewer ? "you" : task.createdBy}</span>
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
