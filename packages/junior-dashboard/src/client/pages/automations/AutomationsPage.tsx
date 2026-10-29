import { useEffect, useRef, useState } from "react";
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import {
  automationListQuerySchema,
  type AutomationSummary,
} from "@sentry/junior/api/schema";
import { Globe2, ListChecks, LockKeyhole, UserRound } from "lucide-react";
import { useAutomationsData, useAutomationData } from "../../api";
import { Button } from "../../components/Button";
import { AutomationFilters, AutomationSort } from "./AutomationFilters";
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
import { automationPath } from "../../format";
import { useDocumentTitle } from "../../documentTitle";
import {
  pathWithSearch,
  useDebouncedSearchParam,
  useSearchParamEnum,
} from "../../searchParams";
import { AutomationDeleteDialog } from "./AutomationDeleteDialog";
import { AutomationRow } from "./AutomationRow";
import { AutomationCostChart } from "./AutomationCostChart";
import { AutomationDetails } from "./AutomationDetails";
import { PageLayout } from "../../components/layout/PageLayout";
import { cn } from "../../styles";
import { AutomationExecutionChart } from "./AutomationExecutionChart";

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
  const [deleteTarget, setDeleteTarget] = useState<AutomationSummary>();
  const deleteSource = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
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
  // Ignore only invalid URL values. One bad field must not reset other filters.
  const filters = automationListQuerySchema.parse(
    Object.fromEntries(
      // Zod owns this property name; it is not a Junior domain symbol.
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names
      Object.entries(automationListQuerySchema.shape).flatMap(
        ([key, schema]) => {
          const parsed = schema.safeParse(searchParams.get(key) ?? undefined);
          return parsed.success && parsed.data !== undefined
            ? [[key, parsed.data]]
            : [];
        },
      ),
    ),
  );
  const request = new URLSearchParams(
    Object.entries(filters).map(([key, value]) => [key, String(value)]),
  );
  const query = useAutomationsData(
    props.enabled,
    props.view === "list" ? request.toString() : "",
  );
  const detail = useAutomationData(props.enabled, automationId);
  const setFilter = (key: string, value: string) => {
    // Consecutive control events can precede the router's next render.
    const next = new URLSearchParams(window.location.search);
    next.delete("page");
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };
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
  const totalPages = pageCount(visibleTaskCount, filters.pageSize);
  const page = query.data?.page ?? filters.page;
  const selectedTask = detail.data;
  const closeDetails = () => {
    const trigger = automationId
      ? listRef.current?.querySelector<HTMLButtonElement>(
          `[data-automation-id="${CSS.escape(automationId)}"] button`,
        )
      : undefined;
    navigate(tasksPath(listPath));
    (trigger ?? listRef.current)?.focus();
  };
  // Overview names the tab through PageHeader; the list has a plain heading.
  useDocumentTitle(
    props.view === "list"
      ? (selectedTask?.title ?? "All automations")
      : undefined,
  );
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

  const content = (
    <>
      {props.view === "overview" ? (
        <PageHeader
          description="Scheduled and event-driven work created by users."
          onRangeChange={setRange}
          range={range}
          title="Automations"
        />
      ) : (
        <h2 className="m-0 font-display text-2xl font-light tracking-tight text-dashboard-text sm:text-3xl">
          All automations
        </h2>
      )}
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
          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
            <p className="m-0 text-xs text-dashboard-text-muted">
              {visibleTaskCount}{" "}
              {visibleTaskCount === 1 ? "automation" : "automations"}
              {query.isFetching ? (
                <span className="ml-3" role="status">
                  Updating results…
                </span>
              ) : null}
            </p>
            <AutomationSort
              value={filters.sort}
              onChange={(value) => setFilter("sort", value)}
            />
          </div>
          {!query.error && visibleTaskCount === 0 ? (
            <Card padding="md">
              <p className="m-0 text-sm text-dashboard-text-muted">
                No automations matched these filters.
              </p>
            </Card>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2" role="list">
              {automations.map((automation) => {
                const key = `${automation.kind}:${automation.id}`;
                return (
                  <AutomationRow
                    key={key}
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
          )}
          <PagePagination
            onPageChange={setPage}
            page={page}
            pageCount={totalPages}
            pageSize={filters.pageSize}
            total={visibleTaskCount}
          />
        </>
      ) : null}
    </>
  );
  if (props.view === "overview") return content;

  return (
    <div
      className={cn(
        "grid h-full min-h-0 min-w-0",
        automationId && "xl:grid-cols-[minmax(0,1fr)_25rem]",
      )}
    >
      <div
        aria-label="Automations list"
        className="min-h-0 overflow-y-auto overscroll-contain outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
        ref={listRef}
        role="region"
        tabIndex={0}
      >
        <PageLayout>{content}</PageLayout>
      </div>
      {automationId ? (
        <AutomationDetails
          key={automationId}
          onClose={closeDetails}
          onDelete={(source) => {
            if (!selectedTask?.ownedByViewer) return;
            deleteSource.current = source;
            setDeleteTarget(selectedTask);
          }}
          onRetry={() => void detail.refetch()}
          error={Boolean(detail.error)}
          range={range}
          automation={selectedTask}
        />
      ) : null}
      {deleteTarget ? (
        <AutomationDeleteDialog
          automation={deleteTarget}
          onClose={() => setDeleteTarget(undefined)}
          onDeleted={() => {
            if (automationId === deleteTarget.id) navigate(tasksPath(listPath));
          }}
          returnFocus={() =>
            deleteSource.current?.isConnected
              ? deleteSource.current
              : (listRef.current ?? false)
          }
        />
      ) : null}
    </div>
  );
}
