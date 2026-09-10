import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AutomationSummary } from "@sentry/junior/api/schema";
import {
  CalendarClock,
  ChevronRight,
  Globe2,
  ListChecks,
  LockKeyhole,
  Trash2,
  UserRound,
} from "lucide-react";
import { useAutomationsData } from "../../api";
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
import {
  selectTimeSeries,
  timeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { StatCard } from "../../components/metrics/StatCard";
import { deleteDashboardResource } from "../../http";
import { formatRelativeTime, formatTime, automationPath } from "../../format";
import {
  pathWithSearch,
  useDebouncedSearchParam,
  useSearchParamEnum,
} from "../../searchParams";
import { cn } from "../../styles";
import { AutomationCostChart } from "./AutomationCostChart";
import { AutomationDetailsDrawer } from "./AutomationDetailsDrawer";
import { AutomationExecutionChart } from "./AutomationExecutionChart";

const AUTOMATION_PAGE_SIZE = 25;
const AUTOMATION_RANGE_OPTIONS = ["1", "7", "30", "90"] as const;

type AutomationFilter = "all" | AutomationSummary["kind"];
type AutomationScope = "mine" | "public";

const AUTOMATION_FILTERS = [
  "all",
  "scheduled",
  "event",
] as const satisfies readonly AutomationFilter[];
const AUTOMATION_SCOPES = [
  "mine",
  "public",
] as const satisfies readonly AutomationScope[];

function parseTaskRange(value: string): TimeRangeDays {
  const days = Number(value);
  return (
    days === 1 || days === 7 || days === 30 || days === 90 ? days : 30
  ) as TimeRangeDays;
}

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

const EMPTY_TASKS: AutomationSummary[] = [];

/** Render viewer-owned and public-workspace automations in one native view. */
export function AutomationsPage(props: {
  enabled: boolean;
  view: "list" | "overview";
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { automationId } = useParams();
  const [rangeParam, setRangeParam] = useSearchParamEnum(
    "range",
    "30",
    AUTOMATION_RANGE_OPTIONS,
  );
  const range = parseTaskRange(rangeParam);
  const setRange = (value: TimeRangeDays) =>
    setRangeParam(String(value) as (typeof AUTOMATION_RANGE_OPTIONS)[number]);
  const [filter, setFilter] = useSearchParamEnum(
    "type",
    "all",
    AUTOMATION_FILTERS,
  );
  const [scope, setScope] = useSearchParamEnum(
    "scope",
    "mine",
    AUTOMATION_SCOPES,
  );
  const [searchText, setSearchText, searchQuery] = useDebouncedSearchParam();
  const query = useAutomationsData(props.enabled, searchQuery);
  const [page, setPage] = useState(1);
  const search = searchQuery.toLowerCase();
  const listPath = "/automations/list";
  const tasksPath = (pathname: string) =>
    pathWithSearch(pathname, location.search);
  const selectedTaskPath = (id: string) => tasksPath(automationPath(id));
  const automations = query.data?.automations ?? EMPTY_TASKS;
  const mineCount = automations.filter(
    (automation) => automation.ownedByViewer,
  ).length;
  const publicCount = automations.filter(
    (automation) => automation.destination.visibility === "public",
  ).length;
  const privateCount = automations.filter(
    (automation) => automation.destination.visibility === "private",
  ).length;
  const scopedTasks = useMemo(
    () =>
      automations.filter((automation) =>
        scope === "mine"
          ? automation.ownedByViewer
          : automation.destination.visibility === "public",
      ),
    [scope, automations],
  );
  const visibleTasks = useMemo(
    () =>
      scopedTasks.filter(
        (automation) => filter === "all" || automation.kind === filter,
      ),
    [filter, scopedTasks],
  );
  const visibleTaskCount = visibleTasks.length;
  const totalPages = pageCount(visibleTaskCount, AUTOMATION_PAGE_SIZE);
  const pagedTasks = useMemo(
    () =>
      props.view === "list"
        ? pageItems(visibleTasks, page, AUTOMATION_PAGE_SIZE)
        : visibleTasks,
    [page, props.view, visibleTasks],
  );
  const selectedTask = useMemo(
    () => automations.find((automation) => automation.id === automationId),
    [automationId, automations],
  );

  useEffect(() => {
    setPage(1);
  }, [filter, scope, searchQuery, props.view]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  const deletion = useMutation({
    mutationFn: async (automation: AutomationSummary) => {
      await deleteDashboardResource(
        `/api/automations/${automation.kind}/${encodeURIComponent(automation.id)}`,
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["dashboard", "automations"],
      });
    },
  });

  const loading = !query.data && !query.error;
  const executionSeries = query.data?.executionDays?.length
    ? selectTimeSeries({
        days: query.data.executionDays,
        hours: query.data.executionHours,
        sixHours: query.data.executionSixHours,
        range,
        emptySixHour: (date) => ({
          costUsd: 0,
          date,
          event: 0,
          scheduled: 0,
        }),
      })
    : [];
  const showExecutionCharts = executionSeries.length > 0;

  return (
    <>
      <PageHeader
        description={
          props.view === "overview"
            ? "Scheduled and event-driven work created by users."
            : "Find and manage automations across your linked workspaces."
        }
        onRangeChange={setRange}
        range={range}
        title={props.view === "overview" ? "Automations" : "All automations"}
      />
      {loading ? (
        <PageContentSkeleton
          label="Loading automations"
          variant={props.view === "overview" ? "stats" : "list"}
        />
      ) : null}
      {!loading && props.view === "overview" ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              detail="All automations you can access"
              icon={ListChecks}
              label="Total automations"
              value={automations.length}
            />
            <StatCard
              detail="Created by you"
              icon={UserRound}
              label="Your automations"
              value={mineCount}
            />
            <StatCard
              detail="In shared destinations"
              icon={Globe2}
              label="Public automations"
              value={publicCount}
            />
            <StatCard
              detail="Visible only to you"
              icon={LockKeyhole}
              label="Private automations"
              value={privateCount}
            />
          </div>
          {showExecutionCharts ? (
            <section className="grid gap-4 xl:grid-cols-2">
              <AutomationExecutionChart
                bucketUnit={timeRangeBucketUnit(range)}
                days={executionSeries}
                range={range}
              />
              <AutomationCostChart
                bucketUnit={timeRangeBucketUnit(range)}
                days={executionSeries}
                range={range}
              />
            </section>
          ) : null}
        </>
      ) : null}
      {!loading && props.view === "list" ? (
        <>
          {showExecutionCharts ? (
            <section className="grid gap-4 xl:grid-cols-2">
              <AutomationExecutionChart
                bucketUnit={timeRangeBucketUnit(range)}
                days={executionSeries}
                range={range}
              />
              <AutomationCostChart
                bucketUnit={timeRangeBucketUnit(range)}
                days={executionSeries}
                range={range}
              />
            </section>
          ) : null}
          <FilterBar
            search={{
              label: "Search automations",
              onChange: setSearchText,
              placeholder: "Title",
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
              {visibleTaskCount}{" "}
              {visibleTaskCount === 1 ? "automation" : "automations"}
            </p>
            <p className="m-0 text-xs text-dashboard-text-muted">
              {scope === "mine"
                ? "Automations you created, including private destinations."
                : "All automations assigned to public destinations in your linked workspaces."}
            </p>
          </div>
          {query.error ? (
            <Card padding="md">
              <InlineError>
                Automations could not be loaded. Try again.
              </InlineError>
            </Card>
          ) : visibleTaskCount === 0 ? (
            <Card padding="md">
              <p className="m-0 text-sm text-dashboard-text-muted">
                {emptyText({ filter, mineCount, publicCount, scope, search })}
              </p>
            </Card>
          ) : (
            <Card>
              <AutomationListHeader />
              <div className="divide-y divide-white/[0.07]" role="list">
                {pagedTasks.map((automation) => {
                  const key = `${automation.kind}:${automation.id}`;
                  return (
                    <TaskRow
                      deleting={
                        deletion.isPending &&
                        deletion.variables?.id === automation.id
                      }
                      key={key}
                      onDelete={() => {
                        if (
                          window.confirm(
                            `Delete this ${automation.kind} automation?`,
                          )
                        ) {
                          deletion.mutate(automation);
                        }
                      }}
                      onSelect={() =>
                        navigate(
                          automationId === automation.id
                            ? tasksPath(listPath)
                            : selectedTaskPath(automation.id),
                        )
                      }
                      range={range}
                      selected={automationId === automation.id}
                      automation={automation}
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
            pageSize={AUTOMATION_PAGE_SIZE}
            total={visibleTaskCount}
          />
          {query.data?.truncated ? (
            <p className="m-0 text-center text-xs text-dashboard-text-muted">
              Showing up to 100 recent automations in each scope.
            </p>
          ) : null}
          {deletion.error ? (
            <InlineError className="text-center">
              The automation could not be deleted. Try again.
            </InlineError>
          ) : null}
          <AutomationDetailsDrawer
            onClose={() => navigate(tasksPath(listPath))}
            range={range}
            automation={selectedTask}
          />
        </>
      ) : null}
    </>
  );
}

function emptyText(input: {
  filter: AutomationFilter;
  mineCount: number;
  publicCount: number;
  scope: AutomationScope;
  search: string;
}): string {
  if (input.search || input.filter !== "all") {
    return "No automations matched these filters.";
  }
  if (input.scope === "mine" && input.mineCount === 0) {
    return "You have no active or completed automations.";
  }
  if (input.scope === "public" && input.publicCount === 0) {
    return "No automations are assigned to public destinations in your linked workspaces.";
  }
  return "No automations are available.";
}

function AutomationListHeader() {
  return (
    <div
      aria-hidden="true"
      className="hidden grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_4.5rem_7.5rem_auto_auto] items-center gap-3 border-b border-white/[0.07] px-4 py-2.5 text-left font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted lg:grid"
    >
      <span>Automation</span>
      <span>Destination</span>
      <span>Trigger</span>
      <span>Runs</span>
      <span>Last run</span>
      <span aria-hidden="true" className="size-8" />
      <span aria-hidden="true" className="size-9" />
    </div>
  );
}

function TaskRow(props: {
  deleting: boolean;
  onDelete(): void;
  onSelect(): void;
  range: TimeRangeDays;
  selected: boolean;
  automation: AutomationSummary;
}) {
  const { range, automation } = props;
  const runCount = automation.runs[range];
  return (
    <article role="listitem">
      <SelectableRow
        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-3 md:grid-cols-[repeat(2,minmax(0,1fr))_auto_auto] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_4.5rem_7.5rem_auto_auto]"
        onSelect={props.onSelect}
        selected={props.selected}
      >
        <button
          aria-expanded={props.selected}
          className="flex min-w-0 cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-left"
          onClick={props.onSelect}
          type="button"
        >
          <TaskSourceMark automation={automation} />
          <span className="min-w-0">
            <span className="block truncate font-display text-base font-medium text-dashboard-text">
              {automation.title}
            </span>
            <span className="mt-1 block truncate font-mono text-xs uppercase tracking-[0.08em] text-dashboard-text-muted">
              <span className="md:hidden">{automation.destination.label}</span>
              <span className="hidden md:inline">
                {formatDate(automation.createdAt)}
              </span>
            </span>
          </span>
        </button>
        <div className="hidden min-w-0 md:block">
          <div className="truncate text-sm font-medium text-dashboard-text">
            {automation.destination.label}
          </div>
          <div className="mt-1 font-mono text-xs uppercase tracking-[0.08em] text-dashboard-text-muted">
            {automation.destination.visibility}
          </div>
        </div>
        <div className="hidden min-w-0 lg:block">
          <div className="truncate text-sm text-dashboard-text">
            {automation.kind === "scheduled"
              ? automation.schedule
              : automation.resource}
          </div>
          <div className="mt-1 truncate font-mono text-xs text-dashboard-text-muted">
            {automation.kind === "scheduled"
              ? automation.nextRunAt
                ? `Next ${formatRunDate(automation.nextRunAt)}`
                : "No next run"
              : automation.events.join(", ")}
          </div>
        </div>
        <div className="hidden min-w-0 lg:block">
          <div className="truncate text-sm font-medium text-dashboard-text">
            {runCount}
          </div>
        </div>
        <div className="hidden min-w-0 lg:block">
          <div className="truncate text-sm text-dashboard-text">
            {automation.lastRunAt
              ? formatRelativeTime(automation.lastRunAt)
              : "Never"}
          </div>
          <div className="mt-1 truncate font-mono text-xs text-dashboard-text-muted">
            {automation.lastRunAt
              ? formatRunDate(automation.lastRunAt)
              : "No executions"}
          </div>
        </div>
        <button
          aria-expanded={props.selected}
          aria-label={`View automation details: ${automation.title}`}
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
        {automation.ownedByViewer ? (
          <Button
            aria-label={`Delete: ${automation.title}`}
            disabled={props.deleting}
            onClick={props.onDelete}
            size="icon"
            title="Delete automation"
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

function TaskSourceMark(props: { automation: AutomationSummary }) {
  const { automation } = props;
  if (automation.kind === "scheduled") {
    return (
      <div
        aria-label="Scheduled automation"
        className="grid size-9 shrink-0 place-items-center rounded border border-white/[0.08] bg-white/[0.03] text-cyan-300/75"
        role="img"
        title="Scheduled automation"
      >
        <CalendarClock aria-hidden="true" size={16} />
      </div>
    );
  }
  const source = automation.source.trim();
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
      aria-label={`${sourceLabel} event automation`}
      className="grid size-9 shrink-0 place-items-center rounded border border-white/[0.08] bg-white/[0.03] text-cyan-300/75"
      role="img"
      title={`${sourceLabel} event automation`}
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
