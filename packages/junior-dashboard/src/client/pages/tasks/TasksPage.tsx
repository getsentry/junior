import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskSummary } from "@sentry/junior/api/schema";
import {
  CalendarClock,
  ChevronRight,
  Globe2,
  ListChecks,
  LockKeyhole,
  Trash2,
  UserRound,
} from "lucide-react";
import { useTasksData } from "../../api";
import { Button, ToggleButton } from "../../components/Button";
import { FilterBar, FilterGroup } from "../../components/FilterBar";
import { InlineError } from "../../components/InlineError";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import {
  pageCount,
  pageItems,
  PagePagination,
} from "../../components/Pagination";
import { SelectableRow } from "../../components/SelectableRow";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { StatCard } from "../../components/metrics/StatCard";
import { deleteDashboardResource } from "../../http";
import { formatTime, taskPath } from "../../format";
import {
  pathWithSearch,
  useDebouncedSearchParam,
  useSearchParamEnum,
} from "../../searchParams";
import { cn } from "../../styles";
import { TaskDetailsDrawer } from "./TaskDetailsDrawer";
import { TaskExecutionChart } from "./TaskExecutionChart";

const TASK_PAGE_SIZE = 25;

type TaskFilter = "all" | TaskSummary["kind"];
type TaskScope = "mine" | "public";

const TASK_FILTERS = [
  "all",
  "scheduled",
  "event",
] as const satisfies readonly TaskFilter[];
const TASK_SCOPES = ["mine", "public"] as const satisfies readonly TaskScope[];

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

const EMPTY_TASKS: TaskSummary[] = [];

function taskMatches(task: TaskSummary, search: string): boolean {
  const haystack = [
    task.createdBy,
    task.destination.channelId,
    task.destination.label,
    task.destination.teamId,
    task.instruction,
    task.kind,
    task.title,
    task.kind === "scheduled" ? task.schedule : task.resource,
    ...(task.kind === "event" ? [task.source] : []),
    ...(task.kind === "event" ? task.events : []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}

/** Render viewer-owned and public-workspace tasks in one native view. */
export function TasksPage(props: {
  enabled: boolean;
  view: "list" | "overview";
}) {
  const [range, setRange] = useState<TimeRangeDays>(30);
  const query = useTasksData(props.enabled);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { taskId } = useParams();
  const [filter, setFilter] = useSearchParamEnum("type", "all", TASK_FILTERS);
  const [scope, setScope] = useSearchParamEnum("scope", "mine", TASK_SCOPES);
  const [searchText, setSearchText, searchQuery] = useDebouncedSearchParam();
  const [page, setPage] = useState(1);
  const search = searchQuery.toLowerCase();
  const listPath = "/tasks/list";
  const tasksPath = (pathname: string) =>
    pathWithSearch(pathname, location.search);
  const selectedTaskPath = (id: string) => tasksPath(taskPath(id));
  const tasks = query.data?.tasks ?? EMPTY_TASKS;
  const mineCount = tasks.filter((task) => task.ownedByViewer).length;
  const publicCount = tasks.filter(
    (task) => task.destination.visibility === "public",
  ).length;
  const privateCount = tasks.filter(
    (task) => task.destination.visibility === "private",
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
  const visibleTaskCount = visibleTasks.length;
  const totalPages = pageCount(visibleTaskCount, TASK_PAGE_SIZE);
  const pagedTasks = useMemo(
    () =>
      props.view === "list"
        ? pageItems(visibleTasks, page, TASK_PAGE_SIZE)
        : visibleTasks,
    [page, props.view, visibleTasks],
  );
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === taskId),
    [taskId, tasks],
  );

  useEffect(() => {
    setPage(1);
  }, [filter, scope, searchQuery, props.view]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
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

  const loading = !query.data && !query.error;

  return (
    <>
      <PageHeader
        description={
          props.view === "overview"
            ? "Scheduled and event-driven work created by users."
            : "Find and manage tasks across your linked workspaces."
        }
        {...(props.view === "overview" && query.data?.executionDays?.length
          ? { onRangeChange: setRange, range }
          : {})}
        title={props.view === "overview" ? "Tasks" : "All tasks"}
      />
      {loading ? (
        <PageContentSkeleton
          label="Loading tasks"
          variant={props.view === "overview" ? "stats" : "list"}
        />
      ) : null}
      {!loading && props.view === "overview" ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              detail="All tasks you can access"
              icon={ListChecks}
              label="Total tasks"
              value={tasks.length}
            />
            <StatCard
              detail="Created by you"
              icon={UserRound}
              label="Your tasks"
              value={mineCount}
            />
            <StatCard
              detail="In shared destinations"
              icon={Globe2}
              label="Public tasks"
              value={publicCount}
            />
            <StatCard
              detail="Visible only to you"
              icon={LockKeyhole}
              label="Private tasks"
              value={privateCount}
            />
          </div>
          {query.data?.executionDays?.length ? (
            <TaskExecutionChart days={query.data.executionDays} range={range} />
          ) : null}
        </>
      ) : null}
      {!loading && props.view === "list" ? (
        <>
          <FilterBar
            search={{
              label: "Search tasks",
              onChange: setSearchText,
              placeholder: "Title, instruction, location, or creator",
              value: searchText,
            }}
          >
            <FilterGroup label="Scope">
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
            </FilterGroup>
            <FilterGroup label="Type">
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
            </FilterGroup>
          </FilterBar>
          <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 border-b border-white/[0.07] pb-3">
            <p className="m-0 font-display text-lg text-dashboard-text">
              {visibleTaskCount} {visibleTaskCount === 1 ? "task" : "tasks"}
            </p>
            <p className="m-0 text-xs text-dashboard-text-muted">
              {scope === "mine"
                ? "Tasks you created, including private destinations."
                : "All tasks assigned to public destinations in your linked workspaces."}
            </p>
          </div>
          {query.error ? (
            <Card padding="md">
              <InlineError>Tasks could not be loaded. Try again.</InlineError>
            </Card>
          ) : visibleTaskCount === 0 ? (
            <Card padding="md">
              <p className="m-0 text-sm text-dashboard-text-muted">
                {emptyText({ filter, mineCount, publicCount, scope, search })}
              </p>
            </Card>
          ) : (
            <Card>
              <TaskListHeader />
              <div className="divide-y divide-white/[0.07]" role="list">
                {pagedTasks.map((task) => {
                  const key = `${task.kind}:${task.id}`;
                  return (
                    <TaskRow
                      deleting={
                        deletion.isPending && deletion.variables?.id === task.id
                      }
                      key={key}
                      onDelete={() => {
                        if (window.confirm(`Delete this ${task.kind} task?`)) {
                          deletion.mutate(task);
                        }
                      }}
                      onSelect={() =>
                        navigate(
                          taskId === task.id
                            ? tasksPath(listPath)
                            : selectedTaskPath(task.id),
                        )
                      }
                      selected={taskId === task.id}
                      task={task}
                    />
                  );
                })}
              </div>
            </Card>
          )}
          <PagePagination
            onPageChange={setPage}
            page={page}
            pageCount={totalPages}
            pageSize={TASK_PAGE_SIZE}
            total={visibleTaskCount}
          />
          {query.data?.truncated ? (
            <p className="m-0 text-center text-xs text-dashboard-text-muted">
              Showing up to 100 recent tasks in each scope.
            </p>
          ) : null}
          {deletion.error ? (
            <InlineError className="text-center">
              The task could not be deleted. Try again.
            </InlineError>
          ) : null}
          <TaskDetailsDrawer
            onClose={() => navigate(tasksPath(listPath))}
            task={selectedTask}
          />
        </>
      ) : null}
    </>
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
    return "You have no active or completed tasks.";
  }
  if (input.scope === "public" && input.publicCount === 0) {
    return "No tasks are assigned to public destinations in your linked workspaces.";
  }
  return "No tasks are available.";
}

function TaskListHeader() {
  return (
    <div
      aria-hidden="true"
      className="hidden grid-cols-[repeat(3,minmax(0,1fr))_auto_auto] items-center gap-3 border-b border-white/[0.07] px-4 py-2.5 text-left font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted lg:grid"
    >
      <span>Task</span>
      <span>Destination</span>
      <span>Trigger</span>
      <span aria-hidden="true" className="size-8" />
      <span aria-hidden="true" className="size-9" />
    </div>
  );
}

function TaskRow(props: {
  deleting: boolean;
  onDelete(): void;
  onSelect(): void;
  selected: boolean;
  task: TaskSummary;
}) {
  const { task } = props;
  return (
    <article role="listitem">
      <SelectableRow
        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-3 md:grid-cols-[repeat(2,minmax(0,1fr))_auto_auto] lg:grid-cols-[repeat(3,minmax(0,1fr))_auto_auto]"
        onSelect={props.onSelect}
        selected={props.selected}
      >
        <button
          aria-expanded={props.selected}
          className="flex min-w-0 cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-left"
          onClick={props.onSelect}
          type="button"
        >
          <TaskSourceMark task={task} />
          <span className="min-w-0">
            <span className="block truncate font-display text-base font-medium text-dashboard-text">
              {task.title}
            </span>
            <span className="mt-1 block truncate font-mono text-xs uppercase tracking-[0.08em] text-dashboard-text-muted">
              <span className="md:hidden">{task.destination.label}</span>
              <span className="hidden md:inline">
                {formatDate(task.createdAt)}
              </span>
            </span>
          </span>
        </button>
        <div className="hidden min-w-0 md:block">
          <div className="truncate text-sm font-medium text-dashboard-text">
            {task.destination.label}
          </div>
          <div className="mt-1 font-mono text-xs uppercase tracking-[0.08em] text-dashboard-text-muted">
            {task.destination.visibility}
          </div>
        </div>
        <div className="hidden min-w-0 lg:block">
          <div className="truncate text-sm text-dashboard-text">
            {task.kind === "scheduled" ? task.schedule : task.resource}
          </div>
          <div className="mt-1 truncate font-mono text-xs text-dashboard-text-muted">
            {task.kind === "scheduled"
              ? task.nextRunAt
                ? `Next ${formatRunDate(task.nextRunAt)}`
                : "No next run"
              : task.events.join(", ")}
          </div>
        </div>
        <button
          aria-expanded={props.selected}
          aria-label={`View task details: ${task.title}`}
          className="grid size-8 cursor-pointer place-items-center rounded border border-transparent bg-transparent text-dashboard-text-muted transition-colors hover:border-white/10 hover:bg-white/[0.04] hover:text-dashboard-text"
          onClick={props.onSelect}
          type="button"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "transition-transform",
              props.selected && "translate-x-0.5 text-cyan-200",
            )}
            size={16}
          />
        </button>
        {task.ownedByViewer ? (
          <Button
            aria-label={`Delete: ${task.title}`}
            disabled={props.deleting}
            onClick={props.onDelete}
            size="icon"
            title="Delete task"
          >
            <Trash2 aria-hidden="true" size={15} />
          </Button>
        ) : (
          <span aria-hidden="true" className="size-8" />
        )}
      </SelectableRow>
    </article>
  );
}

function TaskSourceMark(props: { task: TaskSummary }) {
  const { task } = props;
  if (task.kind === "scheduled") {
    return (
      <div
        aria-label="Scheduled task"
        className="grid size-9 shrink-0 place-items-center rounded border border-white/[0.08] bg-white/[0.03] text-cyan-300/75"
        role="img"
        title="Scheduled task"
      >
        <CalendarClock aria-hidden="true" size={16} />
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
      className="grid size-9 shrink-0 place-items-center rounded border border-white/[0.08] bg-white/[0.03] text-cyan-300/75"
      role="img"
      title={`${sourceLabel} event task`}
    >
      {isGitHub ? (
        <GitHubMark />
      ) : (
        <span className="font-mono text-xs font-semibold uppercase tracking-[0.08em]">
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
