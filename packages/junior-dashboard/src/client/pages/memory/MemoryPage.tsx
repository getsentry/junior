import {
  Bookmark,
  BrainCircuit,
  CircleAlert,
  Database,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import type { PluginUserPageLink } from "@sentry/junior-plugin-api";

import { InlineError } from "../../components/InlineError";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { LoadMorePagination } from "../../components/Pagination";
import { SearchInput } from "../../components/SearchInput";
import { SelectableRow } from "../../components/SelectableRow";
import {
  selectTimeSeries,
  timeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { AnchorHeading } from "../../components/layout/AnchorHeading";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import {
  type PluginUserPageRecord,
  type PluginUserPageRecordAction,
  usePluginUserPageData,
} from "../user/pluginUserPageData";
import { pathWithSearch } from "../../searchParams";
import { cn } from "../../styles";
import {
  type MemoryDashboardData,
  useMemoryDashboardData,
} from "./memoryDashboard";
import { MemoryDetails } from "./MemoryDetails";
import { MemoryPageLayout } from "./MemoryPageLayout";
import { MemorySearchHighlight } from "./MemorySearchHighlight";
import { MemoryTimeline } from "./MemoryTimeline";
import { MemoryCostChart } from "./MemoryCostChart";
import { useMemoryRecord } from "./memoryRecord";

/**
 * Leading memory column flexes; type and date columns stay equal fixed
 * widths on `sm` and up. Below `sm` those columns are hidden.
 */
const MEMORY_GRID = "grid-cols-1 sm:grid-cols-[minmax(0,1fr)_7rem_9rem]";

/** Render the temporary first-class dashboard experience for memory. */
export function MemoryPage(props: { page: PluginUserPageLink }) {
  const [range, setRange] = useState<TimeRangeDays>(30);
  const location = useLocation();
  const { memoryId } = useParams();
  const basePath = "/memories";
  const libraryPath = `${basePath}/library`;
  const overview = location.pathname === basePath;
  const library = location.pathname === libraryPath || Boolean(memoryId);
  if (!overview && !library) return <Navigate replace to={basePath} />;

  return (
    <MemoryPageLayout>
      {overview ? (
        <>
          <PageHeader
            description={props.page.description}
            onRangeChange={setRange}
            range={range}
            title={props.page.label}
          />
          <MemoryOverview range={range} />
        </>
      ) : (
        <MemoryLibrary libraryPath={libraryPath} page={props.page} />
      )}
    </MemoryPageLayout>
  );
}

function MemoryOverview(props: { range: TimeRangeDays }) {
  const dashboardQuery = useMemoryDashboardData();
  if (dashboardQuery.error) {
    return (
      <Card className="flex items-center gap-3 border-rose-300/20 p-5 text-sm text-rose-200">
        <CircleAlert aria-hidden="true" size={18} />
        Memory history is temporarily unavailable.
      </Card>
    );
  }
  if (!dashboardQuery.data) {
    return (
      <PageContentSkeleton
        className="gap-6 sm:gap-8"
        label="Loading memory history"
        variant="overview"
      />
    );
  }
  return (
    <>
      <section className="grid gap-4 xl:grid-cols-2">
        <MemoryTimeline
          bucketUnit={timeRangeBucketUnit(props.range)}
          days={selectTimeSeries({
            days: dashboardQuery.data.days,
            hours: dashboardQuery.data.hours,
            range: props.range,
            emptySixHour: (date) => ({ count: 0, date }),
          })}
          range={props.range}
        />
        <MemoryCostChart
          bucketUnit={timeRangeBucketUnit(props.range)}
          extractionDays={selectTimeSeries({
            days: dashboardQuery.data.extractionDays,
            hours: dashboardQuery.data.extractionHours,
            range: props.range,
            emptySixHour: (date) => ({ costUsd: 0, date, events: 0 }),
          })}
          range={props.range}
          recallDays={selectTimeSeries({
            days: dashboardQuery.data.recallDays,
            hours: dashboardQuery.data.recallHours,
            range: props.range,
            emptySixHour: (date) => ({ costUsd: 0, date, events: 0 }),
          })}
        />
      </section>
      <MemorySummary data={dashboardQuery.data} />
      <section className="grid gap-4 md:grid-cols-2">
        <MemoryKindPanel data={dashboardQuery.data} />
        <MemoryOriginPanel data={dashboardQuery.data} />
      </section>
    </>
  );
}

function MemoryLibrary(props: {
  libraryPath: string;
  page: PluginUserPageLink;
}) {
  const {
    action,
    content,
    query,
    records,
    runAction,
    searchQuery,
    searchText,
    setSearchText,
  } = usePluginUserPageData(props.page);
  const navigate = useNavigate();
  const location = useLocation();
  const { memoryId } = useParams();
  const listRef = useRef<HTMLDivElement>(null);
  const memoryQuery = useMemoryRecord(memoryId);
  const selectedRecord =
    memoryQuery.data ?? records.find((record) => record.id === memoryId);
  const memoryPath = (pathname: string) =>
    pathWithSearch(pathname, location.search);
  const closeDetails = () => {
    const trigger = memoryId
      ? listRef.current?.querySelector<HTMLButtonElement>(
          `button[data-memory-id="${CSS.escape(memoryId)}"]`,
        )
      : undefined;
    void navigate(memoryPath(props.libraryPath));
    (trigger ?? listRef.current)?.focus();
  };
  const forget = (recordAction: PluginUserPageRecordAction) => {
    // The forgotten row leaves the list, so focus the list instead.
    void navigate(memoryPath(props.libraryPath));
    listRef.current?.focus();
    runAction(recordAction);
  };

  useEffect(() => {
    // Forget leaves the shared mutation in success or error. Clear it when
    // another memory opens, so old action feedback does not stay visible.
    if (memoryId) action.reset();
    // oxlint-disable-next-line react/exhaustive-deps -- reset only on open id change
  }, [memoryId]);

  useEffect(() => {
    // Drop stale permalinks after a forget/archive or unknown id once the
    // direct memory read has settled without a record.
    if (
      !memoryId ||
      selectedRecord ||
      memoryQuery.isFetching ||
      memoryQuery.isPending
    ) {
      return;
    }
    if (memoryQuery.isError || memoryQuery.isFetched) {
      void navigate(pathWithSearch(props.libraryPath, location.search), {
        replace: true,
      });
    }
  }, [
    location.search,
    memoryId,
    memoryQuery.isError,
    memoryQuery.isFetched,
    memoryQuery.isFetching,
    memoryQuery.isPending,
    navigate,
    props.libraryPath,
    selectedRecord,
  ]);

  const loading = !query.data && !query.error;

  return (
    <div
      className={cn(
        "grid h-full min-h-0 min-w-0",
        memoryId && "xl:grid-cols-[minmax(0,1fr)_25rem]",
      )}
    >
      <div
        aria-label="Memories list"
        className="min-h-0 overflow-y-auto overscroll-contain outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
        ref={listRef}
        role="region"
        tabIndex={0}
      >
        <PageLayout className="gap-6 sm:gap-8">
          <PageHeader
            description={props.page.description}
            title={props.page.label}
          />
          <section
            className="grid gap-4"
            aria-labelledby="memory-library-title"
          >
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2
                  className="m-0 font-display text-xl font-medium tracking-[-0.02em] text-dashboard-text"
                  id="memory-library-title"
                >
                  {searchQuery ? "Search results" : "What Junior remembers"}
                </h2>
              </div>
              {content?.searchPlaceholder ? (
                <SearchInput
                  className="w-full max-w-md sm:w-auto"
                  label={content.searchPlaceholder}
                  onChange={setSearchText}
                  placeholder={content.searchPlaceholder}
                  size="default"
                  value={searchText}
                />
              ) : null}
            </div>

            {loading ? (
              <PageContentSkeleton label="Loading memories" variant="panel" />
            ) : query.error ? (
              <Card className="flex items-center gap-3 border-rose-300/20 p-5 text-sm text-rose-200">
                <CircleAlert aria-hidden="true" size={18} />
                {query.error.message}
              </Card>
            ) : records.length === 0 ? (
              <Card className="grid min-h-56 place-items-center p-8 text-center">
                <div>
                  <Database
                    aria-hidden="true"
                    className="mx-auto text-dashboard-text-muted"
                    size={26}
                  />
                  <p className="mt-4 mb-0 text-sm text-dashboard-text-muted">
                    {content?.emptyText ?? "No memories yet."}
                  </p>
                </div>
              </Card>
            ) : (
              <div className="grid gap-3">
                <Card padding="none">
                  <MemoryListHeader />
                  {records.map((record, index) => (
                    <MemoryRow
                      first={index === 0}
                      key={record.id}
                      onSelect={() =>
                        navigate(
                          memoryPath(
                            memoryId === record.id
                              ? props.libraryPath
                              : `/memories/${encodeURIComponent(record.id)}`,
                          ),
                        )
                      }
                      record={record}
                      searchQuery={searchQuery}
                      selected={record.id === memoryId}
                    />
                  ))}
                </Card>
                <LoadMorePagination
                  className="mt-2"
                  hasMore={
                    !query.isPlaceholderData && Boolean(query.hasNextPage)
                  }
                  loading={query.isFetchingNextPage}
                  onLoadMore={() => void query.fetchNextPage()}
                />
                {action.error ? (
                  <InlineError className="text-center">
                    Could not complete this action. Try again.
                  </InlineError>
                ) : null}
              </div>
            )}
          </section>
        </PageLayout>
      </div>
      {memoryId ? (
        <MemoryDetails
          forgetPending={action.isPending}
          key={memoryId}
          onClose={closeDetails}
          onForget={forget}
          record={selectedRecord}
        />
      ) : null}
    </div>
  );
}

function MemoryListHeader() {
  return (
    <div
      className={cn(
        "hidden items-center gap-3 border-b border-dashboard-border px-4 py-2.5 text-left font-sans font-medium text-xs text-dashboard-text-muted sm:grid",
        MEMORY_GRID,
      )}
      role="row"
    >
      <div>Memory</div>
      <div>Type</div>
      <div>Learned</div>
    </div>
  );
}

function MemorySummary(props: { data: MemoryDashboardData }) {
  const { stats } = props.data;
  const items = [
    {
      detail: "shared across the workspace",
      label: "Total active",
      tone: "text-dashboard-accent-text",
      value: stats.active.toLocaleString("en-US"),
    },
    {
      detail: "in the last 30 days",
      label: "Added · 30d",
      value: `+${stats.createdThirtyDays.toLocaleString("en-US")}`,
    },
  ];
  return (
    <section
      aria-label="Memory summary"
      className="grid grid-cols-2 gap-px border-y border-dashboard-border-subtle bg-dashboard-fill-hover"
    >
      {items.map((item) => (
        <div className="bg-dashboard-bg px-4 py-4 sm:px-5" key={item.label}>
          <div className="font-sans font-medium text-xs text-dashboard-text-muted">
            {item.label}
          </div>
          <div
            className={cn(
              "mt-2 font-display text-3xl font-light tracking-[-0.04em] text-dashboard-text",
              item.tone,
            )}
          >
            {item.value}
          </div>
          <div className="mt-1 font-sans text-xs leading-relaxed text-dashboard-text-muted">
            {item.detail}
          </div>
        </div>
      ))}
    </section>
  );
}

function MemoryKindPanel(props: { data: MemoryDashboardData }) {
  const { stats } = props.data;
  return (
    <Card className="p-5 sm:p-6">
      <AnchorHeading
        anchor="memory-types"
        className="m-0 font-display text-xl font-medium text-dashboard-text"
        title="What Junior remembers"
      />
      <div className="mt-5 grid gap-px overflow-hidden rounded-md border border-dashboard-border-subtle bg-dashboard-fill-hover">
        <OverviewBreakdownRow
          detail="How people like to work"
          icon={UserRound}
          label="Preferences"
          value={stats.preference}
        />
        <OverviewBreakdownRow
          detail="How work should get done"
          icon={Database}
          label="Procedures"
          value={stats.procedure}
        />
        <OverviewBreakdownRow
          detail="Facts and durable context"
          icon={BrainCircuit}
          label="Knowledge"
          value={stats.knowledge}
        />
      </div>
    </Card>
  );
}

function MemoryOriginPanel(props: { data: MemoryDashboardData }) {
  const { stats } = props.data;
  const other = Math.max(0, stats.active - stats.automatic - stats.explicit);
  return (
    <Card className="p-5 sm:p-6">
      <AnchorHeading
        anchor="memory-sources"
        className="m-0 font-display text-xl font-medium text-dashboard-text"
        title="How they got here"
      />
      <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
        Same totals, split by how they were written.
      </p>
      <div className="mt-5 grid gap-px overflow-hidden rounded-md border border-dashboard-border-subtle bg-dashboard-fill-hover">
        <OverviewBreakdownRow
          detail="Passive extraction after runs"
          icon={Sparkles}
          label="Learned by Junior"
          value={stats.automatic}
        />
        <OverviewBreakdownRow
          detail="Someone asked to remember it"
          icon={Bookmark}
          label="Saved explicitly"
          value={stats.explicit}
        />
        <OverviewBreakdownRow
          detail="Before origin tracking"
          icon={BrainCircuit}
          label="Older records"
          value={other}
        />
      </div>
    </Card>
  );
}

function OverviewBreakdownRow(props: {
  detail: string;
  icon: typeof UserRound;
  label: string;
  value: number;
}) {
  const Icon = props.icon;
  return (
    <div className="flex items-center gap-3 bg-dashboard-bg-elevated px-3 py-3">
      <div className="grid size-9 shrink-0 place-items-center rounded-md border border-dashboard-border bg-dashboard-fill-soft text-dashboard-text-muted">
        <Icon aria-hidden="true" size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-display text-base font-medium text-dashboard-text">
          {props.label}
        </div>
        <div className="mt-0.5 font-sans text-xs leading-relaxed text-dashboard-text-muted">
          {props.detail}
        </div>
      </div>
      <div className="font-display text-2xl font-light text-dashboard-text">
        {props.value.toLocaleString("en-US")}
      </div>
    </div>
  );
}

function MemoryRow(props: {
  first: boolean;
  onSelect(): void;
  record: PluginUserPageRecord;
  searchQuery: string;
  selected: boolean;
}) {
  const kind = metadataValue(props.record, "Type");
  const remembered = metadataValue(props.record, "Remembered");
  const source = metadataValue(props.record, "Source");
  return (
    <SelectableRow
      className={cn(
        "flex items-stretch",
        !props.first && "border-t border-dashboard-border-subtle",
      )}
      onSelect={props.onSelect}
      selected={props.selected}
    >
      <button
        aria-expanded={props.selected}
        aria-label={`View memory details: ${props.record.title}`}
        data-memory-id={props.record.id}
        className={cn(
          "grid min-w-0 flex-1 cursor-pointer items-center gap-3 border-0 bg-transparent px-4 py-3 text-left",
          MEMORY_GRID,
        )}
        onClick={props.onSelect}
        type="button"
      >
        <div className="min-w-0 overflow-hidden">
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            <h3 className="m-0 truncate font-display text-base font-medium leading-snug text-dashboard-text">
              <MemorySearchHighlight
                query={props.searchQuery}
                text={props.record.title}
              />
            </h3>
          </div>
          <div className="mt-1.5 truncate font-sans text-xs leading-relaxed text-dashboard-text-muted">
            Source: {source}
            <span className="sm:hidden">
              {" "}
              · {kind} · {shortDate(remembered)}
            </span>
          </div>
        </div>
        <span className="hidden truncate font-mono text-xs text-dashboard-text-muted sm:block">
          {kind}
        </span>
        <span className="hidden truncate font-mono text-xs text-dashboard-text sm:block">
          {shortDate(remembered)}
        </span>
      </button>
    </SelectableRow>
  );
}

function metadataValue(record: PluginUserPageRecord, label: string): string {
  return record.metadata?.find((item) => item.label === label)?.value ?? "—";
}

function shortDate(value: string): string {
  return value.split(",").slice(0, 2).join(",");
}
