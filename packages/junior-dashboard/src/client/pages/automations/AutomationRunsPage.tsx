import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Zap } from "lucide-react";
import type { AutomationRun } from "@sentry/junior/api/schema";

import { useAutomationRunsData } from "../../api";
import { FilterBar, FilterGroup } from "../../components/FilterBar";
import { InlineError } from "../../components/InlineError";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import {
  pageCount,
  pageItems,
  PagePagination,
} from "../../components/Pagination";
import { SelectableRow } from "../../components/SelectableRow";
import { StatusDot } from "../../components/StatusDot";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import {
  formatCompactNumber,
  formatCostSummary,
  formatRuntime,
} from "../../format";
import {
  useDebouncedSearchParam,
  useSearchParamEnum,
} from "../../searchParams";
import { cn } from "../../styles";
import {
  AutomationRunDetails,
  AutomationRunsFrame,
  RunConversationLink,
  useAutomationRunSelection,
} from "./AutomationRunDetails";
import {
  automationRunStatusTone,
  automationRunTitle,
  formatAutomationRunTime,
} from "./automationFormat";

const RUN_PAGE_SIZE = 25;
const RUN_KINDS = ["all", "scheduled", "event"] as const;
const RUN_STATUSES = ["all", "completed", "failed", "blocked"] as const;
const EMPTY_RUNS: AutomationRun[] = [];
/** Leading label columns flex; metric columns stay equal fixed widths. */
const RUN_GRID =
  "grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_5.5rem_5.5rem_5.5rem_2rem]";

type RunKindFilter = (typeof RUN_KINDS)[number];
type RunStatusFilter = (typeof RUN_STATUSES)[number];

/** Render newest runs across every automation visible to the signed-in viewer. */
export function AutomationRunsPage(props: { enabled: boolean }) {
  const query = useAutomationRunsData(props.enabled);
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
          run.automationTitle,
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
  const selection = useAutomationRunSelection(
    pagedRuns.map((run) => run.executionId),
  );
  const selectedRun = selection.runId
    ? runs.find((run) => run.executionId === selection.runId)
    : undefined;

  return (
    <AutomationRunsFrame
      details={
        selection.runId ? (
          <AutomationRunDetails
            key={selection.runId}
            loading={loading}
            onClose={selection.close}
            run={selectedRun}
            showAutomation
          />
        ) : null
      }
      label="Runs list"
      listRef={selection.listRef}
    >
      <PageHeader
        description="Newest runs across your automations and automations in public destinations."
        title="Runs"
      />
      {loading ? (
        <PageContentSkeleton label="Loading automation runs" variant="list" />
      ) : (
        <>
          <FilterBar
            search={{
              label: "Search runs",
              onChange: setSearchText,
              placeholder: "Automation, conversation, or status",
              value: searchText,
            }}
          >
            <FilterGroup label="Type">
              <ToggleGroup
                className="flex-wrap gap-2"
                onValueChange={([next]) => {
                  if (next) setKind(next);
                }}
                value={[kind]}
              >
                {RUN_KINDS.map((value) => (
                  <ToggleGroupItem key={value} value={value} variant="pill">
                    {value}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FilterGroup>
            <FilterGroup label="Status">
              <ToggleGroup
                className="flex-wrap gap-2"
                onValueChange={([next]) => {
                  if (next) setStatus(next);
                }}
                value={[status]}
              >
                {RUN_STATUSES.map((value) => (
                  <ToggleGroupItem key={value} value={value} variant="pill">
                    {value}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
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
              <InlineError>
                Automation runs could not be loaded. Try again.
              </InlineError>
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
                    aria-hidden="true"
                    className={cn(
                      "sticky top-0 z-[1] hidden items-center gap-4 border-b border-dashboard-border-subtle bg-dashboard-overlay-soft px-4 py-2.5 font-sans font-medium text-xs text-dashboard-text-muted md:grid",
                      RUN_GRID,
                    )}
                  >
                    <div>Run</div>
                    <div>Automation</div>
                    <div>Duration</div>
                    <div>Tokens</div>
                    <div>Cost</div>
                  </div>
                  <div
                    className="min-w-0"
                    onKeyDown={selection.onRowsKeyDown}
                    role="list"
                  >
                    {pagedRuns.map((run) => (
                      <AutomationRunRow
                        key={`${run.kind}:${run.executionId}`}
                        onSelect={() => selection.toggle(run.executionId)}
                        run={run}
                        selected={selection.runId === run.executionId}
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
    </AutomationRunsFrame>
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
  return "No visible automations have run yet.";
}

function AutomationRunRow(props: {
  onSelect(): void;
  run: AutomationRun;
  selected: boolean;
}) {
  const { run } = props;
  const costLabel =
    formatCostSummary(
      run.costUsd === undefined ? undefined : { total: run.costUsd },
    ) || "—";
  const durationLabel = formatRuntime(run.durationMs) || "—";
  const tokensLabel =
    run.totalTokens === undefined ? "—" : formatCompactNumber(run.totalTokens);

  return (
    <div
      className="border-b border-dashboard-border-subtle last:border-b-0"
      data-run-id={run.executionId}
      role="listitem"
    >
      <SelectableRow
        className={cn(
          "grid min-w-0 items-center gap-4 overflow-hidden px-4 py-3 max-md:grid-cols-1 max-md:gap-y-2 max-md:py-3.5",
          RUN_GRID,
        )}
        onSelect={props.onSelect}
        selected={props.selected}
      >
        <button
          aria-expanded={props.selected}
          className="block min-w-0 cursor-pointer rounded-md border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          onClick={props.onSelect}
          type="button"
        >
          <span className="block truncate text-sm font-medium leading-snug text-dashboard-text">
            {automationRunTitle(run, run.automationTitle)}
          </span>
          <span className="mt-1 block truncate text-xs text-dashboard-text-muted">
            {formatAutomationRunTime(run.executedAt)}
          </span>
        </button>
        <div className="min-w-0 overflow-hidden">
          <div className="truncate text-sm text-dashboard-text">
            {run.automationTitle}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden text-dashboard-text-muted">
            <AutomationKindIcon kind={run.kind} />
            <StatusDot
              label={run.status}
              tone={automationRunStatusTone(run.status)}
            />
            <span className="truncate text-xs text-dashboard-text-muted">
              {run.status}
            </span>
          </div>
        </div>
        <MetricCell label="Duration" value={durationLabel} />
        <MetricCell label="Tokens" value={tokensLabel} />
        <MetricCell label="Cost" value={costLabel} />
        <div className="max-md:hidden">
          <RunConversationLink conversationId={run.conversationId} />
        </div>
      </SelectableRow>
    </div>
  );
}

function MetricCell(props: { label: string; value: string }) {
  return (
    <div className="min-w-0 max-md:flex max-md:items-center max-md:gap-2">
      <div
        aria-hidden="true"
        className="mb-1 hidden font-sans font-medium text-2xs text-dashboard-text-muted max-md:mb-0 max-md:block"
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

function AutomationKindIcon(props: { kind: AutomationRun["kind"] }) {
  const Icon = props.kind === "scheduled" ? CalendarClock : Zap;
  const label =
    props.kind === "scheduled" ? "Scheduled automation" : "Event automation";
  return (
    <span
      aria-label={label}
      className="inline-flex size-3.5 shrink-0 items-center justify-center text-dashboard-accent/80"
      role="img"
      title={label}
    >
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={1.8} />
    </span>
  );
}
