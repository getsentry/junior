import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Zap } from "lucide-react";
import { useNavigate } from "react-router";
import type { TaskRun } from "@sentry/junior/api/schema";

import { useTaskRunsData } from "../../api";
import { ToggleButton } from "../../components/Button";
import { FilterBar, FilterGroup } from "../../components/FilterBar";
import { InlineError } from "../../components/InlineError";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import {
  pageCount,
  pageItems,
  PagePagination,
} from "../../components/Pagination";
import type { StatusChipTone } from "../../components/StatusChip";
import { StatusDot } from "../../components/StatusDot";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { conversationPath } from "../../conversations/conversationRoutes";
import {
  formatCompactNumber,
  formatCostSummary,
  formatRuntime,
  formatTime,
} from "../../format";
import {
  useDebouncedSearchParam,
  useSearchParamEnum,
} from "../../searchParams";
import { cn } from "../../styles";

const RUN_PAGE_SIZE = 25;
const RUN_KINDS = ["all", "scheduled", "event"] as const;
const RUN_STATUSES = ["all", "completed", "failed", "blocked"] as const;
const EMPTY_RUNS: TaskRun[] = [];
/** Leading label columns flex; metric columns stay equal fixed widths. */
const RUN_GRID =
  "grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_5.5rem_5.5rem_5.5rem]";

type RunKindFilter = (typeof RUN_KINDS)[number];
type RunStatusFilter = (typeof RUN_STATUSES)[number];

/** Render newest runs across every task visible to the signed-in viewer. */
export function TaskRunsPage(props: { enabled: boolean }) {
  const query = useTaskRunsData(props.enabled);
  const [kind, setKind] = useSearchParamEnum("type", "all", RUN_KINDS);
  const [status, setStatus] = useSearchParamEnum("status", "all", RUN_STATUSES);
  const [searchText, setSearchText, searchQuery] = useDebouncedSearchParam();
  const [page, setPage] = useState(1);
  const search = searchQuery.toLowerCase();
  const runs = query.data?.runs ?? EMPTY_RUNS;
  const visibleRuns = useMemo(
    () =>
      runs.filter((run) => {
        if (kind !== "all" && run.kind !== kind) return false;
        if (status !== "all" && run.status !== status) return false;
        if (!search) return true;
        const haystack = [
          run.kind,
          run.status,
          run.taskTitle,
          run.title,
          run.conversationId,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(search);
      }),
    [kind, runs, search, status],
  );
  const totalPages = pageCount(visibleRuns.length, RUN_PAGE_SIZE);
  const pagedRuns = useMemo(
    () => pageItems(visibleRuns, page, RUN_PAGE_SIZE),
    [page, visibleRuns],
  );

  useEffect(() => {
    setPage(1);
  }, [kind, searchQuery, status]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const loading = !query.data && !query.error;

  return (
    <>
      <PageHeader
        description="Newest runs across your tasks and tasks in public destinations."
        title="Runs"
      />
      {loading ? (
        <PageContentSkeleton label="Loading task runs" variant="list" />
      ) : (
        <>
          <FilterBar
            search={{
              label: "Search runs",
              onChange: setSearchText,
              placeholder: "Task, conversation, or status",
              value: searchText,
            }}
          >
            <FilterGroup label="Type">
              {RUN_KINDS.map((value) => (
                <ToggleButton
                  key={value}
                  onClick={() => setKind(value)}
                  pressed={kind === value}
                  variant="pill"
                >
                  {value}
                </ToggleButton>
              ))}
            </FilterGroup>
            <FilterGroup label="Status">
              {RUN_STATUSES.map((value) => (
                <ToggleButton
                  key={value}
                  onClick={() => setStatus(value)}
                  pressed={status === value}
                  variant="pill"
                >
                  {value}
                </ToggleButton>
              ))}
            </FilterGroup>
          </FilterBar>
          <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 border-b border-dashboard-border-subtle pb-3">
            <p className="m-0 text-sm text-dashboard-text-muted">
              {visibleRuns.length} {visibleRuns.length === 1 ? "run" : "runs"}
              <span className="text-dashboard-text-muted/70">
                {" "}
                · newest first
              </span>
            </p>
          </div>
          {query.error ? (
            <Card padding="md">
              <InlineError>Task runs could not be loaded. Try again.</InlineError>
            </Card>
          ) : visibleRuns.length === 0 ? (
            <Card padding="md">
              <p className="m-0 text-sm text-dashboard-text-muted">
                {emptyRunsText({ kind, search, status })}
              </p>
            </Card>
          ) : (
            <Card>
              <div className="min-w-0 overflow-x-auto">
                <div className="min-w-[44rem]">
                  <div
                    className={cn(
                      "sticky top-0 z-[1] hidden items-center gap-4 border-b border-dashboard-border-subtle bg-dashboard-overlay-soft px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted md:grid",
                      RUN_GRID,
                    )}
                    role="row"
                  >
                    <div>Run</div>
                    <div>Task</div>
                    <div>Duration</div>
                    <div>Tokens</div>
                    <div>Cost</div>
                  </div>
                  <div className="min-w-0" role="table">
                    {pagedRuns.map((run) => (
                      <TaskRunRow
                        key={`${run.kind}:${run.executionId}`}
                        run={run}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          )}
          <PagePagination
            onPageChange={setPage}
            page={page}
            pageCount={totalPages}
            pageSize={RUN_PAGE_SIZE}
            total={visibleRuns.length}
          />
          {query.data?.truncated ? (
            <p className="m-0 text-center text-xs text-dashboard-text-muted">
              Showing the 100 most recent runs.
            </p>
          ) : null}
        </>
      )}
    </>
  );
}

function emptyRunsText(input: {
  kind: RunKindFilter;
  search: string;
  status: RunStatusFilter;
}): string {
  if (input.search || input.kind !== "all" || input.status !== "all") {
    return "No runs matched these filters.";
  }
  return "No visible tasks have run yet.";
}

function TaskRunRow(props: { run: TaskRun }) {
  const { run } = props;
  const navigate = useNavigate();
  const title =
    run.title?.trim() ||
    (run.conversationId ? run.taskTitle : "No conversation");
  const costLabel =
    formatCostSummary(
      run.costUsd === undefined ? undefined : { total: run.costUsd },
    ) || "—";
  const durationLabel = formatRuntime(run.durationMs) || "—";
  const tokensLabel =
    run.totalTokens === undefined
      ? "—"
      : formatCompactNumber(run.totalTokens);
  const openConversation = () => {
    if (run.conversationId) navigate(conversationPath(run.conversationId));
  };

  return (
    <div
      aria-disabled={!run.conversationId}
      className={cn(
        "group grid min-w-0 items-center gap-4 overflow-hidden border-b border-dashboard-border-subtle px-4 py-3 text-left text-inherit transition-colors last:border-b-0 max-md:grid-cols-1 max-md:gap-y-2 max-md:px-4 max-md:py-3.5 md:grid",
        RUN_GRID,
        run.conversationId
          ? "cursor-pointer hover:bg-dashboard-fill-soft"
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
      <div className="min-w-0 overflow-hidden">
        <div className="truncate text-sm font-medium leading-snug text-dashboard-text">
          {title}
        </div>
        <div className="mt-1 truncate text-xs text-dashboard-text-muted">
          {formatRunDate(run.executedAt)}
        </div>
      </div>
      <div className="min-w-0 overflow-hidden">
        <div className="truncate text-sm text-dashboard-text">{run.taskTitle}</div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden text-dashboard-text-muted">
          <TaskKindIcon kind={run.kind} />
          <StatusDot label={run.status} tone={runStatusTone(run.status)} />
          <span className="truncate font-mono text-2xs uppercase tracking-[0.08em]">
            {run.status}
          </span>
        </div>
      </div>
      <MetricCell label="Duration" value={durationLabel} />
      <MetricCell label="Tokens" value={tokensLabel} />
      <MetricCell label="Cost" value={costLabel} />
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

function TaskKindIcon(props: { kind: TaskRun["kind"] }) {
  const Icon = props.kind === "scheduled" ? CalendarClock : Zap;
  const label = props.kind === "scheduled" ? "Scheduled task" : "Event task";
  return (
    <span
      aria-label={label}
      className="inline-flex size-3.5 shrink-0 items-center justify-center text-cyan-300/80"
      role="img"
      title={label}
    >
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={1.8} />
    </span>
  );
}

function runStatusTone(status: TaskRun["status"]): StatusChipTone {
  if (status === "failed") return "danger";
  if (status === "blocked") return "warning";
  return "success";
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
