import {
  Bookmark,
  BrainCircuit,
  ChevronRight,
  CircleAlert,
  Database,
  Globe2,
  LockKeyhole,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import type { PluginUserPageLink } from "@sentry/junior-plugin-api";

import { FilterTabList } from "../../components/FilterBar";
import { LoadingView } from "../../components/LoadingView";
import { LoadMorePagination } from "../../components/Pagination";
import { SearchInput } from "../../components/SearchInput";
import { SelectableRow } from "../../components/SelectableRow";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";
import {
  type PluginUserPageRecord,
  usePluginUserPageData,
} from "../user/pluginUserPageData";
import { pathWithSearch } from "../../searchParams";
import { cn } from "../../styles";
import {
  type MemoryDashboardData,
  useMemoryDashboardData,
} from "./memoryDashboard";
import { MemoryDetailsDrawer } from "./MemoryDetailsDrawer";
import { MemoryTimeline } from "./MemoryTimeline";
import { MemoryCostChart } from "./MemoryCostChart";
import { useMemoryRecord } from "./memoryRecord";

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
  const libraryHref = pathWithSearch(libraryPath, location.search);

  return (
    <div className="min-w-0">
      <SecondaryNavigation
        ariaLabel="Memory navigation"
        items={[
          { end: true, label: "Overview", to: basePath },
          { label: "Memories", to: libraryHref },
        ]}
      />
      <PageLayout className="gap-6 sm:gap-8">
        <PageHeader
          description={props.page.description}
          {...(overview ? { onRangeChange: setRange, range } : {})}
          title={props.page.label}
        />
        {overview ? (
          <MemoryOverview range={range} />
        ) : (
          <MemoryLibrary libraryPath={libraryPath} page={props.page} />
        )}
      </PageLayout>
    </div>
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
      <>
        <Card className="min-h-64 animate-pulse">
          <span className="sr-only">Loading memory history</span>
        </Card>
        <div className="h-24 animate-pulse border-y border-white/[0.06]">
          <span className="sr-only">Loading memory summary</span>
        </div>
      </>
    );
  }
  return (
    <>
      <section className="grid gap-4 xl:grid-cols-2">
        <MemoryTimeline days={dashboardQuery.data.days} range={props.range} />
        <MemoryCostChart
          extractionDays={dashboardQuery.data.extractionDays}
          range={props.range}
          recallDays={dashboardQuery.data.recallDays}
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
    filter,
    query,
    records,
    runAction,
    searchQuery,
    searchText,
    setFilter,
    setSearchText,
  } = usePluginUserPageData(props.page);
  const dashboardQuery = useMemoryDashboardData();
  const navigate = useNavigate();
  const location = useLocation();
  const { memoryId } = useParams();
  const memoryQuery = useMemoryRecord(memoryId);
  const selectedRecord =
    memoryQuery.data ?? records.find((record) => record.id === memoryId);
  const memoryPath = (pathname: string) =>
    pathWithSearch(pathname, location.search);

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
      navigate(pathWithSearch(props.libraryPath, location.search), {
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

  if (!query.data && !query.error) {
    return <LoadingView label="Loading memories" />;
  }

  return (
    <section className="grid gap-4" aria-labelledby="memory-library-title">
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

      <FilterTabList
        ariaLabel="Memory collections"
        items={[
          {
            count: dashboardQuery.data?.stats?.active,
            label: "All",
            value: "",
          },
          {
            count: dashboardQuery.data?.stats?.personal,
            label: "Private",
            value: "private",
          },
          {
            count: dashboardQuery.data?.stats?.public,
            label: "Public",
            value: "public",
          },
        ]}
        onChange={setFilter}
        value={filter}
      />

      {query.error ? (
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
                selected={record.id === memoryId}
              />
            ))}
          </Card>
          <LoadMorePagination
            className="mt-2"
            hasMore={!query.isPlaceholderData && Boolean(query.hasNextPage)}
            loading={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
          {action.error ? (
            <p className="m-0 text-center text-sm text-rose-300">
              Could not complete this action. Try again.
            </p>
          ) : null}
        </div>
      )}
      <MemoryDetailsDrawer
        action={action}
        onAction={runAction}
        onClose={() => navigate(memoryPath(props.libraryPath))}
        record={selectedRecord}
      />
    </section>
  );
}

function MemoryListHeader() {
  return (
    <div
      aria-hidden="true"
      className="hidden grid-cols-[minmax(0,1fr)_7rem_7rem_9rem_auto] items-center gap-3 border-b border-white/[0.07] px-4 py-2.5 text-left font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted sm:grid"
    >
      <span>Memory</span>
      <span>Visibility</span>
      <span>Type</span>
      <span>Learned</span>
      <span aria-hidden="true" className="size-4" />
    </div>
  );
}

function MemorySummary(props: { data: MemoryDashboardData }) {
  const { stats } = props.data;
  const items = [
    {
      detail: "personal + public",
      label: "Total active",
      value: stats.active.toLocaleString("en-US"),
    },
    {
      detail: "private to you",
      label: "Personal",
      value: stats.personal.toLocaleString("en-US"),
    },
    {
      detail: "workspace shareable",
      label: "Public",
      tone: "text-cyan-100",
      value: stats.public.toLocaleString("en-US"),
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
      className="grid grid-cols-2 gap-px border-y border-white/[0.06] bg-white/[0.06] lg:grid-cols-4"
    >
      {items.map((item) => (
        <div className="bg-[#050507] px-4 py-4 sm:px-5" key={item.label}>
          <div className="font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
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
          <div className="mt-1 font-mono text-xs leading-relaxed text-dashboard-text-muted">
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
      <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
        What Junior remembers
      </h2>
      <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
        Across personal and public scopes.
      </p>
      <div className="mt-5 grid gap-px overflow-hidden rounded border border-white/[0.06] bg-white/[0.055]">
        <OverviewBreakdownRow
          detail="Almost entirely personal"
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
      <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
        How they got here
      </h2>
      <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
        Same totals, split by how they were written.
      </p>
      <div className="mt-5 grid gap-px overflow-hidden rounded border border-white/[0.06] bg-white/[0.055]">
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
    <div className="flex items-center gap-3 bg-[#09090b] px-3 py-3">
      <div className="grid size-9 shrink-0 place-items-center rounded border border-white/[0.07] bg-white/[0.025] text-dashboard-text-muted">
        <Icon aria-hidden="true" size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-display text-base font-medium text-dashboard-text">
          {props.label}
        </div>
        <div className="mt-0.5 font-mono text-xs leading-relaxed text-dashboard-text-muted">
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
  selected: boolean;
}) {
  const kind = metadataValue(props.record, "Type");
  const remembered = metadataValue(props.record, "Remembered");
  const source = metadataValue(props.record, "Source");
  const visibility = metadataValue(props.record, "Visibility");
  const isPublic = visibility === "Public";
  return (
    <SelectableRow
      className={cn(
        "flex items-stretch",
        !props.first && "border-t border-white/[0.055]",
      )}
      onSelect={props.onSelect}
      selected={props.selected}
    >
      <button
        aria-expanded={props.selected}
        aria-label={`View memory details: ${props.record.title}`}
        className="grid min-w-0 flex-1 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-0 bg-transparent px-4 py-3 text-left sm:grid-cols-[minmax(0,1fr)_7rem_7rem_9rem_auto]"
        onClick={props.onSelect}
        type="button"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded border",
              props.selected
                ? "border-cyan-300/20 bg-cyan-300/10 text-cyan-100"
                : "border-white/10 bg-white/[0.025] text-dashboard-text-muted",
            )}
          >
            <BrainCircuit aria-hidden="true" size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="m-0 truncate font-display text-base font-medium leading-snug text-dashboard-text">
              {props.record.title}
            </h3>
            <div className="mt-1.5 flex min-w-0 items-center gap-x-2 font-mono text-xs text-dashboard-text-muted">
              <span className="truncate">Source: {source}</span>
              <span
                aria-hidden="true"
                className="text-dashboard-text-muted opacity-30 sm:hidden"
              >
                ·
              </span>
              <span className="truncate sm:hidden">
                {kind} · {visibility} · {shortDate(remembered)}
              </span>
            </div>
          </div>
        </div>
        <span
          className={cn(
            "hidden items-center gap-1.5 rounded border px-2 py-1 font-mono text-2xs uppercase tracking-[0.08em] sm:inline-flex",
            isPublic
              ? "border-emerald-300/20 bg-emerald-300/[0.07] text-emerald-100"
              : "border-white/[0.08] bg-white/[0.025] text-dashboard-text-muted",
          )}
        >
          {isPublic ? (
            <Globe2 aria-hidden="true" size={11} />
          ) : (
            <LockKeyhole aria-hidden="true" size={11} />
          )}
          {visibility}
        </span>
        <span
          className={cn(
            "hidden w-fit rounded border px-2 py-1 font-mono text-2xs uppercase tracking-[0.08em] sm:block",
            memoryKindClass(kind),
          )}
        >
          {kind}
        </span>
        <span className="hidden truncate font-mono text-xs text-dashboard-text sm:block">
          {shortDate(remembered)}
        </span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "shrink-0 transition-transform",
            props.selected
              ? "translate-x-0.5 text-cyan-200"
              : "text-dashboard-text-muted group-hover:text-dashboard-text",
          )}
          size={16}
        />
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

function memoryKindClass(kind: string): string {
  if (kind === "Preference") {
    return "border-cyan-300/20 bg-cyan-300/[0.07] text-cyan-100";
  }
  if (kind === "Procedure") {
    return "border-amber-300/20 bg-amber-300/[0.07] text-amber-100";
  }
  return "border-violet-300/20 bg-violet-300/[0.07] text-violet-100";
}
