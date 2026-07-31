import type { UseMutationResult } from "@tanstack/react-query";
import {
  Bookmark,
  BrainCircuit,
  ChevronRight,
  CircleAlert,
  Database,
  Globe2,
  LockKeyhole,
  Search,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, NavLink, useLocation } from "react-router";
import type { PluginUserPageLink } from "@sentry/junior-plugin-api";

import { Button } from "../../components/Button";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import {
  type PluginUserPageRecord,
  usePluginUserPageData,
} from "../user/pluginUserPageData";
import {
  cn,
  dashboardContainerClass,
  dashboardInteractiveTextClass,
} from "../../styles";
import {
  type MemoryDashboardData,
  useMemoryDashboardData,
} from "./memoryDashboard";
import { MemoryTimeline } from "./MemoryTimeline";

/** Render the temporary first-class dashboard experience for memory. */
export function MemoryPage(props: { page: PluginUserPageLink }) {
  const location = useLocation();
  const basePath = `/plugins/${encodeURIComponent(props.page.pluginName)}/${encodeURIComponent(props.page.id)}`;
  const libraryPath = `${basePath}/library`;
  const overview = location.pathname === basePath;
  const library = location.pathname === libraryPath;
  if (!overview && !library) return <Navigate replace to={basePath} />;

  const navigationClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "relative px-1 py-3 font-mono text-[0.64rem] uppercase tracking-[0.12em] no-underline after:absolute after:inset-x-0 after:bottom-0 after:h-px",
      isActive
        ? "text-cyan-100 after:bg-cyan-300"
        : "text-dashboard-text-muted after:bg-transparent hover:text-dashboard-text",
    );

  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid content-start gap-6 px-4 py-6 sm:gap-8 sm:px-6 sm:py-8 md:px-8",
      )}
    >
      <PageHeader
        description={props.page.description}
        eyebrow="Memory system"
        title={props.page.label}
      />
      <nav
        aria-label="Memory navigation"
        className="flex gap-6 border-b border-white/[0.06]"
      >
        <NavLink className={navigationClass} end to={basePath}>
          Overview
        </NavLink>
        <NavLink className={navigationClass} to={libraryPath}>
          Memories
        </NavLink>
      </nav>
      {overview ? <MemoryOverview /> : <MemoryLibrary page={props.page} />}
    </div>
  );
}

function MemoryOverview() {
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
      <MemoryTimeline days={dashboardQuery.data.days} />
      <MemorySummary data={dashboardQuery.data} />
      <section className="grid gap-4 md:grid-cols-2">
        <MemoryKindPanel data={dashboardQuery.data} />
        <MemoryOriginPanel data={dashboardQuery.data} />
      </section>
    </>
  );
}

function MemoryLibrary(props: { page: PluginUserPageLink }) {
  const {
    action,
    content,
    filter,
    query,
    records,
    searchQuery,
    searchText,
    setFilter,
    setSearchText,
  } = usePluginUserPageData(props.page);
  const dashboardQuery = useMemoryDashboardData();
  const [selectedRecordId, setSelectedRecordId] = useState<string>();
  const selectedRecord = records.find(
    (record) => record.id === selectedRecordId,
  );

  if (!query.data && !query.error) {
    return <LoadingView label="Loading memories" />;
  }

  return (
    <section className="grid gap-4" aria-labelledby="memory-library-title">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-cyan-200/65">
            Your memories
          </div>
          <h2
            className="mt-1 mb-0 font-display text-xl font-medium tracking-[-0.02em] text-dashboard-text"
            id="memory-library-title"
          >
            {searchQuery ? "Search results" : "What Junior remembers"}
          </h2>
        </div>
        {content?.searchPlaceholder ? (
          <label className="relative w-full max-w-md sm:w-auto">
            <span className="sr-only">{content.searchPlaceholder}</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-dashboard-text-muted"
              size={15}
            />
            <input
              className="h-10 w-full min-w-0 rounded border border-white/10 bg-black/20 pr-3 pl-9 font-mono text-xs text-dashboard-text outline-none transition-colors placeholder:text-dashboard-text-muted/70 focus:border-cyan-300/35"
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={content.searchPlaceholder}
              type="search"
              value={searchText}
            />
          </label>
        ) : null}
      </div>

      <MemoryCollections
        activeFilter={filter}
        onSelect={setFilter}
        stats={dashboardQuery.data?.stats}
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
        <div className="grid items-start gap-4">
          <div className="grid gap-3">
            <Card padding="none">
              {records.map((record, index) => (
                <MemoryRow
                  action={action}
                  first={index === 0}
                  key={record.id}
                  onSelect={() =>
                    setSelectedRecordId((current) =>
                      current === record.id ? undefined : record.id,
                    )
                  }
                  record={record}
                  selected={record.id === selectedRecordId}
                />
              ))}
            </Card>
            {!query.isPlaceholderData && query.hasNextPage ? (
              <Button
                className="mt-2 justify-self-center"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            ) : null}
            {action.error ? (
              <p className="m-0 text-center text-sm text-rose-300">
                Could not complete this action. Try again.
              </p>
            ) : null}
          </div>
          <MemoryMobileInspector
            action={action}
            onClose={() => setSelectedRecordId(undefined)}
            record={selectedRecord}
          />
        </div>
      )}
    </section>
  );
}

function MemoryCollections(props: {
  activeFilter: string;
  onSelect(filter: string): void;
  stats: MemoryDashboardData["stats"] | undefined;
}) {
  const collections = [
    { count: props.stats?.active, filter: "", label: "All" },
    {
      count: props.stats?.personal,
      filter: "private",
      label: "Private",
    },
    {
      count: props.stats?.public,
      filter: "public",
      label: "Public",
    },
  ];
  return (
    <div
      aria-label="Memory collections"
      className="grid min-w-0 grid-cols-3 gap-1 border-b border-white/[0.06] sm:flex sm:overflow-x-auto"
      role="tablist"
    >
      {collections.map((collection) => {
        const selected = props.activeFilter === collection.filter;
        return (
          <button
            aria-selected={selected}
            className={cn(
              "relative flex min-w-0 cursor-pointer items-center justify-between gap-2 border-0 bg-transparent px-3 py-2.5 font-mono text-[0.62rem] uppercase tracking-[0.1em] transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-px sm:shrink-0 sm:justify-start",
              selected
                ? "text-cyan-100 after:bg-cyan-300"
                : "text-dashboard-text-muted after:bg-transparent hover:text-dashboard-text",
            )}
            key={collection.filter || "all"}
            onClick={() => props.onSelect(collection.filter)}
            role="tab"
            type="button"
          >
            {collection.label}
            {collection.count !== undefined ? (
              <span
                className={cn(
                  "rounded-sm border px-1.5 py-0.5 text-[0.54rem]",
                  selected
                    ? "border-cyan-300/20 bg-cyan-300/10 text-cyan-100"
                    : "border-white/[0.07] bg-white/[0.025] text-dashboard-text-muted",
                )}
              >
                {collection.count.toLocaleString("en-US")}
              </span>
            ) : null}
          </button>
        );
      })}
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
          <div className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-dashboard-text-muted">
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
          <div className="mt-1 font-mono text-[0.62rem] leading-relaxed text-dashboard-text-muted">
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
      <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-cyan-200/65">
        By type
      </div>
      <h2 className="mt-1 mb-0 font-display text-xl font-medium text-dashboard-text">
        What Junior remembers
      </h2>
      <p className="mt-1 mb-0 font-mono text-[0.64rem] leading-relaxed text-dashboard-text-muted">
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
      <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-cyan-200/65">
        By origin
      </div>
      <h2 className="mt-1 mb-0 font-display text-xl font-medium text-dashboard-text">
        How they got here
      </h2>
      <p className="mt-1 mb-0 font-mono text-[0.64rem] leading-relaxed text-dashboard-text-muted">
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
        <div className="mt-0.5 font-mono text-[0.6rem] leading-relaxed text-dashboard-text-muted">
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
  action: UseMutationResult<
    boolean,
    Error,
    NonNullable<PluginUserPageRecord["actions"]>[number]
  >;
  first: boolean;
  onSelect(): void;
  record: PluginUserPageRecord;
  selected: boolean;
}) {
  const kind = metadataValue(props.record, "Type");
  const learned = metadataValue(props.record, "Learned");
  const remembered = metadataValue(props.record, "Remembered");
  const visibility = metadataValue(props.record, "Visibility");
  const isPublic = visibility === "Public";
  const provenance =
    learned === "Automatic"
      ? "Learned by Junior"
      : learned === "Explicit"
        ? isPublic
          ? "Saved explicitly"
          : "Saved by you"
        : "Recorded earlier";
  return (
    <>
      <div
        className={cn(
          "group flex items-stretch transition-colors",
          !props.first && "border-t border-white/[0.055]",
          props.selected ? "bg-cyan-300/[0.045]" : "hover:bg-white/[0.025]",
        )}
      >
        <button
          aria-pressed={props.selected}
          className="grid min-w-0 flex-1 cursor-pointer grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 border-0 bg-transparent px-4 py-3.5 text-left"
          onClick={props.onSelect}
          type="button"
        >
          <div className="flex min-w-0 items-start gap-3">
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
              <h3 className="m-0 font-display text-base font-medium leading-snug text-dashboard-text">
                {props.record.title}
              </h3>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[0.6rem] text-dashboard-text-muted">
                <span>{provenance}</span>
                <span
                  aria-hidden="true"
                  className="text-dashboard-text-muted opacity-30"
                >
                  ·
                </span>
                <span>{shortDate(remembered)}</span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 sm:hidden",
                    isPublic ? "text-emerald-200" : "text-dashboard-text",
                  )}
                >
                  {isPublic ? (
                    <Globe2 aria-hidden="true" size={10} />
                  ) : (
                    <LockKeyhole aria-hidden="true" size={10} />
                  )}
                  {visibility}
                </span>
              </div>
            </div>
          </div>
          <span
            className={cn(
              "hidden items-center gap-1.5 rounded border px-2 py-1 font-mono text-[0.56rem] uppercase tracking-[0.08em] sm:inline-flex",
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
              "hidden rounded border px-2 py-1 font-mono text-[0.56rem] uppercase tracking-[0.08em] sm:block",
              memoryKindClass(kind),
            )}
          >
            {kind}
          </span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "shrink-0 transition-transform",
              props.selected
                ? "rotate-90 text-cyan-200"
                : "text-dashboard-text-muted group-hover:text-dashboard-text",
            )}
            size={16}
          />
        </button>
      </div>
      {props.selected ? (
        <div className="hidden border-t border-cyan-300/10 bg-black/20 p-5 lg:block">
          <MemoryDetails action={props.action} inline record={props.record} />
        </div>
      ) : null}
    </>
  );
}

function MemoryMobileInspector(props: {
  action: UseMutationResult<
    boolean,
    Error,
    NonNullable<PluginUserPageRecord["actions"]>[number]
  >;
  onClose(): void;
  record: PluginUserPageRecord | undefined;
}) {
  useEffect(() => {
    if (!props.record) return;
    const mobileSheet = window.matchMedia("(max-width: 1023px)");
    const previousOverflow = document.body.style.overflow;
    let scrollLocked = false;
    function updateScrollLock() {
      if (mobileSheet.matches && !scrollLocked) {
        document.body.style.overflow = "hidden";
        scrollLocked = true;
      } else if (!mobileSheet.matches && scrollLocked) {
        document.body.style.overflow = previousOverflow;
        scrollLocked = false;
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && mobileSheet.matches) props.onClose();
    }
    updateScrollLock();
    mobileSheet.addEventListener("change", updateScrollLock);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      if (scrollLocked) document.body.style.overflow = previousOverflow;
      mobileSheet.removeEventListener("change", updateScrollLock);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [props.onClose, props.record]);

  if (!props.record) return null;
  return (
    <div
      className="fixed inset-0 z-40 lg:hidden"
      role="dialog"
      aria-modal="true"
    >
      <button
        aria-label="Close memory details"
        className="absolute inset-0 cursor-default border-0 bg-black/75 backdrop-blur-[2px]"
        onClick={props.onClose}
        type="button"
      />
      <div className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-xl border border-white/10 bg-[#09090b] p-5 shadow-2xl shadow-black sm:inset-x-4 sm:bottom-4 sm:rounded-xl">
        <MemoryDetails
          action={props.action}
          onClose={props.onClose}
          record={props.record}
        />
      </div>
    </div>
  );
}

function MemoryDetails(props: {
  action: UseMutationResult<
    boolean,
    Error,
    NonNullable<PluginUserPageRecord["actions"]>[number]
  >;
  inline?: boolean;
  onClose?: () => void;
  record: PluginUserPageRecord;
}) {
  const kind = metadataValue(props.record, "Type");
  const learned = metadataValue(props.record, "Learned");
  const remembered = metadataValue(props.record, "Remembered");
  const source = metadataValue(props.record, "Source");
  const visibility = metadataValue(props.record, "Visibility");
  const isPublic = visibility === "Public";
  const story =
    learned === "Automatic"
      ? `Junior learned this from a ${source} conversation on ${shortDate(remembered)}.`
      : learned === "Explicit"
        ? isPublic
          ? `Someone asked Junior to remember this on ${shortDate(remembered)}.`
          : `You asked Junior to remember this on ${shortDate(remembered)}.`
        : `Junior recorded this on ${shortDate(remembered)}.`;
  const scopeCopy = isPublic
    ? `It is stored as workspace ${kind.toLowerCase()} for future channels.`
    : `It is stored as a ${kind.toLowerCase()} for future conversations.`;
  const hiddenMetadata = props.inline
    ? ["Type", "Learned", "Source", "Memory ID"]
    : ["Learned", "Source", "Memory ID"];
  const visibleMetadata = (props.record.metadata ?? []).filter(
    (item) => !hiddenMetadata.includes(item.label),
  );
  const forgetAction = props.record.actions?.find(
    (recordAction) => recordAction.tone === "danger",
  );

  return (
    <>
      {!props.inline ? (
        <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] pb-4">
          <div>
            <div className="font-mono text-[0.58rem] uppercase tracking-[0.14em] text-cyan-200/65">
              Memory details
            </div>
            <h3 className="mt-1 mb-0 font-display text-lg font-medium text-dashboard-text">
              What Junior remembers
            </h3>
          </div>
          <div className="ml-auto grid size-9 place-items-center rounded border border-cyan-300/15 bg-cyan-300/[0.075] text-cyan-100">
            <BrainCircuit aria-hidden="true" size={17} />
          </div>
          {props.onClose ? (
            <button
              aria-label="Close memory details"
              className={cn(
                "grid size-9 cursor-pointer place-items-center border-0 bg-transparent",
                dashboardInteractiveTextClass,
              )}
              onClick={props.onClose}
              type="button"
            >
              <X aria-hidden="true" size={18} />
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        className={cn(
          props.inline
            ? "grid gap-6 pt-5 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,0.85fr)]"
            : "",
        )}
      >
        <div>
          {!props.inline ? (
            <p className="mt-5 mb-0 font-display text-xl leading-relaxed text-dashboard-text">
              {props.record.title}
            </p>
          ) : null}
          {props.record.description ? (
            <p className="mt-3 mb-0 text-sm leading-relaxed text-dashboard-text-muted">
              {props.record.description}
            </p>
          ) : null}
          <div
            className={cn(
              "flex items-start gap-3",
              props.inline
                ? "pt-1"
                : "mt-5 rounded border border-cyan-300/12 bg-cyan-300/[0.035] p-3",
            )}
          >
            <BrainCircuit
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-cyan-200/70"
              size={15}
            />
            <div>
              <div className="font-mono text-[0.55rem] uppercase tracking-[0.12em] text-cyan-200/65">
                Why Junior remembers this
              </div>
              <div
                className={cn(
                  "mt-1 leading-relaxed text-dashboard-text",
                  props.inline
                    ? "font-display text-lg"
                    : "font-mono text-[0.66rem]",
                )}
              >
                {story} {scopeCopy}
              </div>
            </div>
          </div>
        </div>
        <div>
          {visibleMetadata?.length ? (
            <dl
              className={cn(
                "grid gap-px overflow-hidden rounded border border-white/[0.06] bg-white/[0.055] sm:grid-cols-2",
                props.inline ? "mt-0" : "mt-6",
              )}
            >
              {visibleMetadata.map((item) => (
                <div
                  className="min-w-0 bg-[#09090b] px-3 py-3"
                  key={item.label}
                >
                  <dt className="font-mono text-[0.54rem] uppercase tracking-[0.12em] text-dashboard-text-muted">
                    {item.label}
                  </dt>
                  <dd className="mt-1.5 ml-0 break-words font-mono text-[0.66rem] leading-relaxed text-dashboard-text">
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {forgetAction ? (
            <button
              className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded border border-rose-300/15 bg-rose-300/[0.035] px-3 py-2 font-mono text-[0.62rem] uppercase tracking-[0.08em] text-rose-200/75 transition-colors hover:border-rose-300/30 hover:bg-rose-300/[0.07] hover:text-rose-100"
              disabled={
                props.action.isPending &&
                props.action.variables?.href === forgetAction.href
              }
              onClick={() => props.action.mutate(forgetAction)}
              type="button"
            >
              <Trash2 aria-hidden="true" size={13} />
              Forget this memory
            </button>
          ) : isPublic ? (
            <div className="mt-4 inline-flex items-center gap-2 rounded border border-white/[0.08] px-3 py-2 font-mono text-[0.62rem] uppercase tracking-[0.08em] text-dashboard-text-muted">
              <Globe2 aria-hidden="true" size={13} />
              View only · public memories can&apos;t be deleted
            </div>
          ) : null}
        </div>
      </div>
    </>
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
