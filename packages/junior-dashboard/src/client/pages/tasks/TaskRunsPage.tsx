import { useEffect, useMemo, useState } from "react";
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
import { StatusChip } from "../../components/StatusChip";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { conversationPath } from "../../conversations/conversationRoutes";
import { formatTime } from "../../format";
import {
  useDebouncedSearchParam,
  useSearchParamEnum,
} from "../../searchParams";
import { cn } from "../../styles";

const RUN_PAGE_SIZE = 25;
const RUN_KINDS = ["all", "scheduled", "event"] as const;
const RUN_STATUSES = ["all", "completed", "failed", "blocked"] as const;
const EMPTY_RUNS: TaskRun[] = [];

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
          <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 border-b border-white/[0.07] pb-3">
            <p className="m-0 font-display text-lg text-dashboard-text">
              {visibleRuns.length} {visibleRuns.length === 1 ? "run" : "runs"}
            </p>
            <p className="m-0 text-xs text-dashboard-text-muted">
              Newest first. Click a run to open its conversation.
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
              <div
                className="sticky top-0 z-[1] hidden grid-cols-[minmax(13rem,1.7fr)_minmax(11rem,1fr)_auto] items-center gap-3 border-b border-white/[0.06] bg-black/25 px-3 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted md:grid"
                role="row"
              >
                <div>Run</div>
                <div>Task</div>
                <div>Status</div>
              </div>
              <div className="min-w-0" role="table">
                {pagedRuns.map((run) => (
                  <TaskRunRow key={`${run.kind}:${run.executionId}`} run={run} />
                ))}
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
      <StatusChip tone={runStatusTone(run.status)}>{run.status}</StatusChip>
    </div>
  );
}

function runStatusTone(
  status: TaskRun["status"],
): "danger" | "success" | "warning" {
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
