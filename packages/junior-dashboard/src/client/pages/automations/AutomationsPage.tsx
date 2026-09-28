import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AutomationSummary } from "@sentry/junior/api/schema";
import { Globe2, ListChecks, LockKeyhole, UserRound } from "lucide-react";
import { useAutomationsData } from "../../api";
import { ToggleButton } from "../../components/Button";
import { FilterBar, FilterGroup } from "../../components/FilterBar";
import { InlineError } from "../../components/InlineError";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import {
  pageCount,
  pageItems,
  PagePagination,
} from "../../components/Pagination";
import {
  selectTimeSeries,
  timeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { StatCard } from "../../components/metrics/StatCard";
import { deleteDashboardResource } from "../../http";
import { automationPath } from "../../format";
import {
  pathWithSearch,
  useDebouncedSearchParam,
  useSearchParamEnum,
} from "../../searchParams";
import { AutomationRow, AutomationListHeader } from "./AutomationRow";
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
        onRangeChange={props.view === "overview" ? setRange : undefined}
        range={props.view === "overview" ? range : undefined}
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
            <Card className="overflow-visible">
              <AutomationListHeader />
              <div
                className="divide-y divide-dashboard-border-subtle"
                role="list"
              >
                {pagedTasks.map((automation) => {
                  const key = `${automation.kind}:${automation.id}`;
                  return (
                    <AutomationRow
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
