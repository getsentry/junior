import { useMemo, useState, type KeyboardEvent } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import type {
  AutomationExecution,
  AutomationExecutionList,
  AutomationRun,
} from "@sentry/junior/api/schema";

import { useAutomationExecutionsData } from "../../api";
import { InlineError } from "../../components/InlineError";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { SelectableRow } from "../../components/SelectableRow";
import { StatusDot } from "../../components/StatusDot";
import {
  selectTimeSeries,
  timeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import {
  formatCompactNumber,
  formatCostSummary,
  formatRuntime,
  automationPath,
} from "../../format";
import { DashboardApiError } from "../../http";
import { pathWithSearch } from "../../searchParams";
import { cn } from "../../styles";
import { AutomationExecutionStatusChart } from "./AutomationExecutionStatusChart";
import {
  AUTOMATION_RUN_PARAM,
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

/** Leading conversation column flexes; metric columns stay equal fixed widths. */
const EXECUTION_GRID =
  "grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_5.5rem_auto_2rem]";

/** Render one automation's terminal executions beside the selected run. */
export function AutomationExecutionsPage(props: { enabled: boolean }) {
  const { automationId } = useParams();
  const [searchParams] = useSearchParams();
  const query = useAutomationExecutionsData(props.enabled, automationId);
  const backSearch = new URLSearchParams(searchParams);
  backSearch.delete(AUTOMATION_RUN_PARAM);
  const backTo = pathWithSearch(
    automationId ? automationPath(automationId) : "/automations/list",
    backSearch,
  );
  const runs = useMemo(
    () =>
      query.data
        ? query.data.executions.map(
            (execution): AutomationRun => ({
              ...execution,
              automationId: query.data.automation.id,
              automationTitle: query.data.automation.title,
              kind: query.data.automation.kind,
            }),
          )
        : [],
    [query.data],
  );
  const selection = useAutomationRunSelection(
    runs.map((run) => run.executionId),
  );

  if (!automationId) {
    return <Navigate replace to="/automations" />;
  }
  const loading = !query.data && !query.error;
  return (
    <AutomationRunsFrame
      details={
        selection.runId ? (
          <AutomationRunDetails
            key={selection.runId}
            loading={loading}
            onClose={selection.close}
            run={runs.find((run) => run.executionId === selection.runId)}
            showAutomation={false}
          />
        ) : null
      }
      label="Executions list"
      listRef={selection.listRef}
    >
      {query.data ? (
        <AutomationExecutionsView
          backTo={backTo}
          data={query.data}
          onRowsKeyDown={selection.onRowsKeyDown}
          onSelect={selection.toggle}
          selectedRunId={selection.runId}
        />
      ) : (
        <>
          <PageHeader
            description="Terminal runs for one scheduled or event automation."
            title="Automation executions"
          />
          {loading ? (
            <PageContentSkeleton
              label="Loading automation executions"
              variant="list"
            />
          ) : (
            <Card padding="md">
              <InlineError>
                {query.error instanceof DashboardApiError &&
                query.error.status === 404
                  ? "This automation was not found or is not visible to you."
                  : "Automation executions could not be loaded. Try again."}
              </InlineError>
              <Link
                className="mt-3 inline-flex items-center gap-2 font-sans text-xs text-dashboard-text-muted no-underline hover:text-dashboard-text"
                to={automationPath(automationId)}
              >
                <ArrowLeft aria-hidden="true" size={14} />
                Back to automations
              </Link>
            </Card>
          )}
        </>
      )}
    </AutomationRunsFrame>
  );
}

function AutomationExecutionsView(props: {
  backTo: string;
  data: AutomationExecutionList;
  onRowsKeyDown(event: KeyboardEvent<HTMLElement>): void;
  onSelect(executionId: string): void;
  selectedRunId: string | undefined;
}) {
  const { data } = props;
  const [range, setRange] = useState<TimeRangeDays>(30);
  const counts = useMemo(
    () => countByStatus(data.executions),
    [data.executions],
  );
  const statusCounts = `${counts.completed} completed · ${counts.failed} failed · ${counts.blocked} blocked`;
  const statusSummary = data.truncated
    ? `${data.automation.totalRuns} total · loaded runs: ${statusCounts}`
    : `${data.automation.totalRuns} total · ${statusCounts}`;

  return (
    <>
      <div>
        <Link
          className="mb-3 inline-flex items-center gap-2 font-sans text-xs text-dashboard-text-muted no-underline hover:text-dashboard-text"
          to={props.backTo}
        >
          <ArrowLeft aria-hidden="true" size={14} />
          Back to automation
        </Link>
        <PageHeader
          description={`${data.automation.kind} automation · ${data.automation.destination.label} · ${statusSummary}`}
          {...(data.executionDays.length > 0
            ? { onRangeChange: setRange, range }
            : {})}
          documentTitle={`${data.automation.title} · Executions`}
          title={data.automation.title}
        />
      </div>

      {data.executionDays.length > 0 ? (
        <AutomationExecutionStatusChart
          bucketUnit={timeRangeBucketUnit(range)}
          days={selectTimeSeries({
            days: data.executionDays,
            hours: data.executionHours,
            sixHours: data.executionSixHours,
            range,
            emptySixHour: (date) => ({
              blocked: 0,
              completed: 0,
              date,
              failed: 0,
            }),
          })}
          range={range}
        />
      ) : null}

      <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 border-b border-dashboard-border-subtle pb-3">
        <p className="m-0 text-sm text-dashboard-text-muted">
          {data.executions.length}{" "}
          {data.executions.length === 1 ? "run" : "runs"}
          <span className="text-dashboard-text-muted/70"> · newest first</span>
        </p>
      </div>

      {data.executions.length === 0 ? (
        <Card padding="md">
          <p className="m-0 text-sm text-dashboard-text-muted">
            This automation has not produced any terminal executions yet.
          </p>
        </Card>
      ) : (
        <Card>
          <div className="min-w-0 overflow-x-auto">
            <div className="min-w-[36rem]">
              <div
                aria-hidden="true"
                className={cn(
                  "sticky top-0 z-[1] hidden items-center gap-4 border-b border-dashboard-border-subtle bg-dashboard-overlay-soft px-4 py-2.5 font-sans font-medium text-xs text-dashboard-text-muted md:grid",
                  EXECUTION_GRID,
                )}
              >
                <div>Run</div>
                <div>Duration</div>
                <div>Tokens</div>
                <div>Cost</div>
              </div>
              <div
                className="min-w-0"
                onKeyDown={props.onRowsKeyDown}
                role="list"
              >
                {data.executions.map((execution) => (
                  <ExecutionRow
                    execution={execution}
                    fallbackTitle={data.automation.title}
                    key={execution.executionId}
                    onSelect={() => props.onSelect(execution.executionId)}
                    selected={props.selectedRunId === execution.executionId}
                  />
                ))}
              </div>
            </div>
          </div>
        </Card>
      )}

      {data.truncated ? (
        <p className="m-0 text-center text-xs text-dashboard-text-muted">
          Showing the 100 most recent executions.
        </p>
      ) : null}
    </>
  );
}

function ExecutionRow(props: {
  execution: AutomationExecution;
  fallbackTitle: string;
  onSelect(): void;
  selected: boolean;
}) {
  const { execution } = props;
  const costLabel =
    formatCostSummary(
      execution.costUsd === undefined
        ? undefined
        : { total: execution.costUsd },
    ) || "—";
  const durationLabel = formatRuntime(execution.durationMs) || "—";
  const tokensLabel =
    execution.totalTokens === undefined
      ? "—"
      : formatCompactNumber(execution.totalTokens);
  const tone = automationRunStatusTone(execution.status);

  return (
    <div
      className="border-b border-dashboard-border-subtle last:border-b-0"
      data-run-id={execution.executionId}
      role="listitem"
    >
      <SelectableRow
        className={cn(
          "grid min-w-0 items-center gap-4 overflow-hidden px-4 py-3 max-md:grid-cols-1 max-md:gap-y-2 max-md:py-3.5",
          EXECUTION_GRID,
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
          <span className="flex min-w-0 items-center gap-2 overflow-hidden">
            <StatusDot
              className="md:hidden"
              label={execution.status}
              tone={tone}
            />
            <span className="min-w-0 truncate text-sm font-medium leading-snug text-dashboard-text">
              {automationRunTitle(execution, props.fallbackTitle)}
            </span>
          </span>
          <span className="mt-1 block truncate text-xs leading-relaxed text-dashboard-text-muted">
            {formatAutomationRunTime(execution.executedAt)}
          </span>
        </button>
        <MetricCell label="Duration" value={durationLabel} />
        <MetricCell label="Tokens" value={tokensLabel} />
        <MetricCell label="Cost" value={costLabel} />
        <div className="hidden justify-self-center md:block">
          <StatusDot label={execution.status} tone={tone} />
        </div>
        <div className="max-md:hidden">
          <RunConversationLink conversationId={execution.conversationId} />
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

function countByStatus(executions: AutomationExecution[]) {
  return executions.reduce(
    (counts, execution) => {
      counts[execution.status] += 1;
      return counts;
    },
    { blocked: 0, completed: 0, failed: 0 },
  );
}
