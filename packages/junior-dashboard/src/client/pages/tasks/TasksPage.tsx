import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskSummary } from "@sentry/junior/api/schema";
import { CalendarClock, Radio, Search, Trash2 } from "lucide-react";
import { useTasksData } from "../../api";
import { Button, ToggleButton } from "../../components/Button";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { deleteDashboardResource } from "../../http";
import { dashboardContainerClass } from "../../styles";

type TaskFilter = "all" | TaskSummary["kind"];

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function taskMatches(task: TaskSummary, search: string): boolean {
  const haystack = [
    task.instruction,
    task.destination.channelId,
    task.destination.teamId,
    task.kind === "scheduled" ? task.schedule : task.resource,
    ...(task.kind === "event" ? task.events : []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}

/** Render viewer-owned scheduled and resource-event tasks in one native view. */
export function TasksPage(props: { enabled: boolean }) {
  const query = useTasksData(props.enabled);
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [searchText, setSearchText] = useState("");
  const search = searchText.trim().toLowerCase();
  const tasks = query.data?.tasks ?? [];
  const visibleTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (filter === "all" || task.kind === filter) &&
          (!search || taskMatches(task, search)),
      ),
    [filter, search, tasks],
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

  const scheduledCount = tasks.filter(
    (task) => task.kind === "scheduled",
  ).length;
  const eventCount = tasks.length - scheduledCount;

  return (
    <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
      <section className="mx-auto grid w-full max-w-5xl gap-6">
        <PageHeader
          description="Durable work Junior runs on a schedule or when a registered resource event occurs."
          eyebrow="Automation"
          title="Tasks"
        />
        <section
          aria-label="Task overview"
          className="grid gap-3 sm:grid-cols-3"
        >
          <TaskMetric label="Total" value={tasks.length} />
          <TaskMetric label="Scheduled" value={scheduledCount} />
          <TaskMetric label="Event" value={eventCount} />
        </section>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-2" role="group" aria-label="Task type">
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
          </div>
          <label className="relative min-w-56 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-dashboard-text-muted"
              size={15}
            />
            <span className="sr-only">Search tasks</span>
            <input
              className="w-full rounded border border-white/15 bg-black py-2 pr-3 pl-9 text-sm text-dashboard-text placeholder:text-dashboard-text-muted focus:border-cyan-300/50 focus:outline-none"
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Search tasks"
              type="search"
              value={searchText}
            />
          </label>
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
              {tasks.length === 0
                ? "You have not created any tasks."
                : "No tasks matched these filters."}
            </p>
          </Card>
        ) : (
          <div className="grid gap-3">
            {visibleTasks.map((task) => (
              <TaskCard
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
        )}
        {query.data?.truncated ? (
          <p className="m-0 text-center text-xs text-dashboard-text-muted">
            Showing the 100 most recent tasks.
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

function TaskMetric(props: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <div className="font-mono text-[0.62rem] uppercase tracking-[0.12em] text-dashboard-text-muted">
        {props.label}
      </div>
      <div className="mt-3 font-display text-2xl font-light text-dashboard-text">
        {props.value}
      </div>
    </Card>
  );
}

function TaskCard(props: {
  deleting: boolean;
  onDelete(): void;
  task: TaskSummary;
}) {
  const { task } = props;
  const Icon = task.kind === "scheduled" ? CalendarClock : Radio;
  return (
    <Card padding="md">
      <div className="flex items-start gap-4">
        <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded border border-white/[0.08] bg-white/[0.03] text-cyan-300/75">
          <Icon aria-hidden="true" size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <h3 className="m-0 min-w-0 flex-1 font-display text-base font-medium text-dashboard-text">
              {task.instruction}
            </h3>
            <Button
              aria-label={`Delete: ${task.instruction}`}
              disabled={props.deleting}
              onClick={props.onDelete}
              size="icon"
              title="Delete task"
            >
              <Trash2 aria-hidden="true" size={15} />
            </Button>
          </div>
          <div className="mt-2 text-sm text-dashboard-text-muted">
            {task.kind === "scheduled" ? task.schedule : task.resource}
          </div>
          <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
            <TaskDetail label="Type" value={task.kind} />
            {task.kind === "scheduled" ? (
              <>
                <TaskDetail label="Status" value={task.status} />
                <TaskDetail
                  label="Next run"
                  value={task.nextRunAt ? formatDate(task.nextRunAt) : "None"}
                />
              </>
            ) : (
              <>
                <TaskDetail label="Events" value={task.events.join(", ")} />
                <TaskDetail
                  label="Trigger"
                  value={task.triggerAvailable ? "Available" : "Unavailable"}
                />
              </>
            )}
            <TaskDetail
              label="Destination"
              value={task.destination.channelId}
            />
            <TaskDetail label="Created" value={formatDate(task.createdAt)} />
          </dl>
        </div>
      </div>
    </Card>
  );
}

function TaskDetail(props: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[0.62rem] uppercase tracking-[0.12em] text-dashboard-text-muted">
        {props.label}
      </dt>
      <dd className="mt-1 ml-0 font-mono text-[0.72rem] text-dashboard-text-muted">
        {props.value}
      </dd>
    </div>
  );
}
