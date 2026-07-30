import type { UseMutationResult } from "@tanstack/react-query";
import {
  BrainCircuit,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  Database,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
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
  const {
    action,
    content,
    query,
    records,
    searchQuery,
    searchText,
    setSearchText,
  } = usePluginUserPageData(props.page);
  const dashboardQuery = useMemoryDashboardData();
  const [selectedRecordId, setSelectedRecordId] = useState<string>();
  const selectedRecord =
    records.find((record) => record.id === selectedRecordId) ?? records[0];

  useEffect(() => {
    if (selectedRecord && selectedRecord.id !== selectedRecordId) {
      setSelectedRecordId(selectedRecord.id);
    }
  }, [selectedRecord, selectedRecordId]);

  if (!query.data && !query.error) {
    return <LoadingView label="Loading memories" />;
  }

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

      {dashboardQuery.data ? (
        <section
          aria-label="Memory overview"
          className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]"
        >
          <MemoryTimeline days={dashboardQuery.data.days} />
          <MemoryAtAGlance data={dashboardQuery.data} />
        </section>
      ) : dashboardQuery.error ? (
        <Card className="flex items-center gap-3 border-rose-300/20 p-5 text-sm text-rose-200">
          <CircleAlert aria-hidden="true" size={18} />
          Memory history is temporarily unavailable.
        </Card>
      ) : (
        <Card className="min-h-[21rem] animate-pulse">
          <span className="sr-only">Loading memory history</span>
        </Card>
      )}

      <section className="grid gap-4" aria-labelledby="memory-library-title">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-cyan-200/65">
              Stored context
            </div>
            <h2
              className="mt-1 mb-0 font-display text-xl font-medium tracking-[-0.02em] text-dashboard-text"
              id="memory-library-title"
            >
              {searchQuery ? "Search results" : "Memory library"}
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
                {content?.emptyText ?? "No personal memories yet."}
              </p>
            </div>
          </Card>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,0.48fr)]">
            <div className="grid gap-2.5">
              {records.map((record) => (
                <MemoryRow
                  action={action}
                  key={record.id}
                  onSelect={() => setSelectedRecordId(record.id)}
                  record={record}
                  selected={record.id === selectedRecord?.id}
                />
              ))}
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
            {selectedRecord ? (
              <MemoryInspector record={selectedRecord} />
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function MemoryAtAGlance(props: { data: MemoryDashboardData }) {
  const { stats } = props.data;
  const coverage = stats.active === 0 ? 0 : stats.embedded / stats.active;
  const mix = [
    { color: "bg-cyan-300", label: "Preferences", value: stats.preference },
    { color: "bg-amber-300", label: "Procedures", value: stats.procedure },
    { color: "bg-violet-300", label: "Knowledge", value: stats.knowledge },
  ];
  return (
    <Card className="grid content-start p-5 sm:p-6">
      <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-cyan-200/65">
        At a glance
      </div>
      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded border border-white/[0.06] bg-white/[0.055] lg:grid-cols-1">
        <div className="bg-[#09090b] p-4">
          <div className="font-display text-3xl font-light tracking-[-0.04em] text-dashboard-text">
            {stats.active.toLocaleString("en-US")}
          </div>
          <div className="mt-1 font-mono text-[0.56rem] uppercase tracking-[0.1em] text-dashboard-text-muted">
            Active memories
          </div>
          <div className="mt-2 font-mono text-[0.62rem] text-emerald-200/70">
            +{stats.createdThirtyDays.toLocaleString("en-US")} in 30 days
          </div>
        </div>
        <div className="bg-[#09090b] p-4">
          <div className="font-display text-3xl font-light tracking-[-0.04em] text-emerald-200">
            {new Intl.NumberFormat("en-US", {
              maximumFractionDigits: 0,
              style: "percent",
            }).format(coverage)}
          </div>
          <div className="mt-1 font-mono text-[0.56rem] uppercase tracking-[0.1em] text-dashboard-text-muted">
            Search ready
          </div>
          <div className="mt-2 font-mono text-[0.62rem] text-dashboard-text-muted">
            {stats.embedded.toLocaleString("en-US")} embedded
          </div>
        </div>
      </div>

      <div className="mt-5 border-t border-white/[0.06] pt-4">
        <h3 className="m-0 font-display text-base font-medium text-dashboard-text">
          Memory mix
        </h3>
        <div className="mt-3 grid gap-3">
          {mix.map((item) => (
            <div key={item.label}>
              <div className="flex items-center justify-between gap-3 font-mono text-[0.62rem]">
                <span className="inline-flex items-center gap-2 text-dashboard-text-muted">
                  <i className={cn("size-2 rounded-sm", item.color)} />
                  {item.label}
                </span>
                <span className="text-dashboard-text">
                  {item.value.toLocaleString("en-US")}
                </span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className={cn("h-full rounded-full opacity-80", item.color)}
                  style={{
                    width: `${stats.active === 0 ? 0 : Math.max(3, (item.value / stats.active) * 100)}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function MemoryRow(props: {
  action: UseMutationResult<
    boolean,
    Error,
    NonNullable<PluginUserPageRecord["actions"]>[number]
  >;
  onSelect(): void;
  record: PluginUserPageRecord;
  selected: boolean;
}) {
  return (
    <Card
      className={cn(
        "group flex items-start gap-3 p-3 transition-colors",
        props.selected
          ? "border-cyan-300/25 bg-cyan-300/[0.045]"
          : "hover:border-white/15 hover:bg-white/[0.025]",
      )}
    >
      <button
        aria-pressed={props.selected}
        className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-1 text-left"
        onClick={props.onSelect}
        type="button"
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "mt-0.5 grid size-8 shrink-0 place-items-center rounded border",
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
            {props.record.metadata?.length ? (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {props.record.metadata.slice(0, 3).map((item) => (
                  <span
                    className="font-mono text-[0.57rem] uppercase tracking-[0.08em] text-dashboard-text-muted"
                    key={item.label}
                  >
                    {item.label}: {item.value}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "mt-1 shrink-0 transition-colors",
              props.selected
                ? "text-cyan-200"
                : "text-dashboard-text-muted group-hover:text-dashboard-text",
            )}
            size={16}
          />
        </div>
      </button>
      {props.record.actions?.map((recordAction) => (
        <button
          aria-label={`${recordAction.label}: ${props.record.title}`}
          className={cn(
            "mt-1 grid size-8 shrink-0 cursor-pointer place-items-center border-0 bg-transparent transition-colors",
            recordAction.tone === "danger"
              ? "text-dashboard-text-muted hover:text-rose-300"
              : dashboardInteractiveTextClass,
          )}
          disabled={
            props.action.isPending &&
            props.action.variables?.href === recordAction.href
          }
          key={`${recordAction.method}:${recordAction.href}`}
          onClick={() => props.action.mutate(recordAction)}
          title={recordAction.label}
          type="button"
        >
          {recordAction.tone === "danger" ? (
            <Trash2 aria-hidden="true" size={15} />
          ) : (
            recordAction.label
          )}
        </button>
      ))}
    </Card>
  );
}

function MemoryInspector(props: { record: PluginUserPageRecord }) {
  const [copied, setCopied] = useState(false);

  async function copyId() {
    await navigator.clipboard.writeText(props.record.id);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <Card className="sticky top-24 p-5 sm:p-6">
      <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] pb-4">
        <div>
          <div className="font-mono text-[0.58rem] uppercase tracking-[0.14em] text-cyan-200/65">
            Memory details
          </div>
          <h3 className="mt-1 mb-0 font-display text-lg font-medium text-dashboard-text">
            Stored context
          </h3>
        </div>
        <div className="grid size-9 place-items-center rounded border border-cyan-300/15 bg-cyan-300/[0.075] text-cyan-100">
          <BrainCircuit aria-hidden="true" size={17} />
        </div>
      </div>
      <p className="mt-5 mb-0 font-display text-xl leading-relaxed text-dashboard-text">
        {props.record.title}
      </p>
      {props.record.description ? (
        <p className="mt-3 mb-0 text-sm leading-relaxed text-dashboard-text-muted">
          {props.record.description}
        </p>
      ) : null}
      {props.record.metadata?.length ? (
        <dl className="mt-6 grid gap-px overflow-hidden rounded border border-white/[0.06] bg-white/[0.055] sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {props.record.metadata.map((item) => (
            <div className="min-w-0 bg-[#09090b] px-3 py-3" key={item.label}>
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
      <button
        className={cn(
          "mt-4 inline-flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 font-mono text-[0.62rem] uppercase tracking-[0.1em]",
          dashboardInteractiveTextClass,
        )}
        onClick={() => void copyId()}
        type="button"
      >
        {copied ? (
          <Check aria-hidden="true" size={13} />
        ) : (
          <Copy aria-hidden="true" size={13} />
        )}
        {copied ? "Copied memory ID" : "Copy memory ID"}
      </button>
    </Card>
  );
}
