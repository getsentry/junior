import { useEffect } from "react";
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  automationListQuerySchema,
  type AutomationSummary,
} from "@sentry/junior/api/schema";
import { Globe2, ListChecks, LockKeyhole, UserRound } from "lucide-react";
import { useAutomationsData, useAutomationData } from "../../api";
import { Button } from "../../components/Button";
import { AutomationFilters } from "./AutomationFilters";
import { InlineError } from "../../components/InlineError";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { pageCount, PagePagination } from "../../components/Pagination";
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchText, setSearchText] = useDebouncedSearchParam("q", {
    resetPage: true,
  });
  const rawFilters = Object.fromEntries(
    [...searchParams].filter(([key]) =>
      [
        "q",
        "scope",
        "type",
        "state",
        "creator",
        "destination",
        "sort",
        "page",
      ].includes(key),
    ),
  );
  const parsed = automationListQuerySchema.safeParse(rawFilters);
  const filters = parsed.success
    ? parsed.data
    : automationListQuerySchema.parse({});
  const request = new URLSearchParams(
    Object.entries(filters).map(([key, value]) => [key, String(value)]),
  );
  const query = useAutomationsData(
    props.enabled,
    props.view === "list" ? request.toString() : "",
  );
  const detail = useAutomationData(props.enabled, automationId);
  const setFilter = (key: string, value: string) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("page");
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  const setPage = (page: number) =>
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (page === 1) next.delete("page");
      else next.set("page", String(page));
      return next;
    });
  const listPath = "/automations/list";
  const tasksPath = (pathname: string) =>
    pathWithSearch(pathname, location.search);
  const selectedTaskPath = (id: string) => tasksPath(automationPath(id));
  const automations = query.data?.automations ?? EMPTY_TASKS;
  const mineCount = query.data?.counts.mine ?? 0;
  const publicCount = query.data?.counts.public ?? 0;
  const privateCount = query.data?.counts.private ?? 0;
  const visibleTaskCount = query.data?.total ?? 0;
  const totalPages = pageCount(visibleTaskCount, AUTOMATION_PAGE_SIZE);
  const page = query.data?.page ?? filters.page;
  const selectedTask = detail.data;
  // A deletion or a shared URL can leave the requested page past the last page.
  useEffect(() => {
    if (
      props.view !== "list" ||
      !query.data ||
      query.isPlaceholderData ||
      query.isFetching ||
      query.data.page === filters.page
    )
      return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("page", String(query.data.page));
        return next;
      },
      { replace: true },
    );
  }, [
    filters.page,
    props.view,
    query.data,
    query.isFetching,
    query.isPlaceholderData,
    setSearchParams,
  ]);
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
      {props.view === "list" ? (
        <AutomationFilters
          filters={filters}
          data={query.data}
          onChange={setFilter}
          searchText={searchText}
          onSearch={setSearchText}
        />
      ) : null}
      {loading ? (
        <PageContentSkeleton
          label="Loading automations"
          variant={props.view === "overview" ? "stats" : "list"}
        />
      ) : null}
      {query.error ? (
        <InlineError>
          Automations could not be loaded.{" "}
          <Button onClick={() => void query.refetch()}>Try again</Button>
        </InlineError>
      ) : null}
      {automationId && detail.isPending ? (
        <p role="status">Loading automation details…</p>
      ) : null}
      {automationId && detail.error ? (
        <InlineError>
          Automation details could not be loaded. It may be unavailable or you
          may not have access.{" "}
          <Button onClick={() => void detail.refetch()}>Try again</Button>
        </InlineError>
      ) : null}
      {query.data && props.view === "overview" ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              detail="All automations you can access"
              icon={ListChecks}
              label="Total automations"
              value={query.data?.counts.all ?? 0}
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
      {query.data && props.view === "list" ? (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 border-b border-white/[0.07] pb-3">
            <p className="m-0 font-display text-lg text-dashboard-text">
              {visibleTaskCount}{" "}
              {visibleTaskCount === 1 ? "automation" : "automations"}
            </p>
            <p className="m-0 text-xs text-dashboard-text-muted">
              {query.isFetching ? (
                <span role="status">Updating results…</span>
              ) : (
                "Only automations you can access are shown."
              )}
            </p>
          </div>
          {!query.error && visibleTaskCount === 0 ? (
            <Card padding="md">
              <p className="m-0 text-sm text-dashboard-text-muted">
                No automations matched these filters.
              </p>
            </Card>
          ) : (
            <Card className="overflow-visible">
              <AutomationListHeader />
              <div
                className="divide-y divide-dashboard-border-subtle"
                role="list"
              >
                {automations.map((automation) => {
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
          {deletion.error ? (
            <InlineError className="text-center">
              The automation could not be deleted. Try again.
            </InlineError>
          ) : null}
        </>
      ) : null}
      <AutomationDetailsDrawer
        onClose={() => navigate(tasksPath(listPath))}
        range={range}
        automation={selectedTask}
      />
    </>
  );
}
