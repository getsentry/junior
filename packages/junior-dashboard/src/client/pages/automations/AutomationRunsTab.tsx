import { useMemo, type KeyboardEvent, type ReactNode } from "react";
import type {
  AutomationExecution,
  AutomationExecutionList,
  AutomationRun,
  AutomationSummary,
} from "@sentry/junior/api/schema";

import { useAutomationExecutionsData } from "../../api";
import { Button } from "../../components/ui/button";
import { FilterTabList } from "../../components/FilterBar";
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
import {
  formatCompactNumber,
  formatCostSummary,
  formatRuntime,
} from "../../format";
import { useSearchParamEnum } from "../../searchParams";
import { cn } from "../../styles";
import { AutomationExecutionStatusChart } from "./AutomationExecutionStatusChart";
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

/** Search param that filters the Runs tab by result. */
export const AUTOMATION_RESULT_PARAM = "result";

const RESULT_OPTIONS = ["", "completed", "failed", "blocked"] as const;

/** Leading run column flexes; metric columns stay equal fixed widths. */
const EXECUTION_GRID =
  "grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_5.5rem_auto_2rem]";

/** Render one Automation's terminal runs beside the selected run. */
export function AutomationRunsTab(props: {
  automation: AutomationSummary;
  header: ReactNode;
  range: TimeRangeDays;
}) {
  const { automation } = props;
  const query = useAutomationExecutionsData(true, automation.id);
  const [result, setResult] = useSearchParamEnum(
    AUTOMATION_RESULT_PARAM,
    "",
    RESULT_OPTIONS,
  );
  const executions = useMemo(
    () =>
      (query.data?.executions ?? []).filter(
        (execution) => !result || execution.status === result,
      ),
    [query.data, result],
  );
  const runs = useMemo(
    () =>
      executions.map(
        (execution): AutomationRun => ({
          ...execution,
          automationId: automation.id,
          automationTitle: automation.title,
          kind: automation.kind,
        }),
      ),
    [automation, executions],
  );
  const selection = useAutomationRunSelection(
    runs.map((run) => run.executionId),
  );
  return (
    <AutomationRunsFrame
      details={
        selection.runId ? (
          <AutomationRunDetails
            key={selection.runId}
            loading={!query.data && !query.error}
            onClose={selection.close}
            run={runs.find((run) => run.executionId === selection.runId)}
            showAutomation={false}
          />
        ) : null
      }
      label="Runs list"
      listRef={selection.listRef}
    >
      {props.header}
      {query.data ? (
        <AutomationRunsView
          data={query.data}
          executions={executions}
          onResultChange={setResult}
          onRowsKeyDown={selection.onRowsKeyDown}
          onSelect={selection.toggle}
          range={props.range}
          result={result}
          selectedRunId={selection.runId}
        />
      ) : query.error ? (
        <InlineError>
          Runs could not be loaded.{" "}
          <Button onClick={() => void query.refetch()}>Try again</Button>
        </InlineError>
      ) : (
        <PageContentSkeleton label="Loading runs" variant="list" />
      )}
    </AutomationRunsFrame>
  );
}

function AutomationRunsView(props: {
  data: AutomationExecutionList;
  executions: AutomationExecution[];
  onResultChange(value: (typeof RESULT_OPTIONS)[number]): void;
  onRowsKeyDown(event: KeyboardEvent<HTMLElement>): void;
  onSelect(executionId: string): void;
  range: TimeRangeDays;
  result: (typeof RESULT_OPTIONS)[number];
  selectedRunId: string | undefined;
}) {
  const { data, range } = props;
  const counts = useMemo(
    () => countByStatus(data.executions),
    [data.executions],
  );

  return (
    <>
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

      <div className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
        <FilterTabList
          ariaLabel="Run result"
          items={[
            { count: data.executions.length, label: "All", value: "" },
            { count: counts.completed, label: "Completed", value: "completed" },
            { count: counts.failed, label: "Failed", value: "failed" },
            { count: counts.blocked, label: "Blocked", value: "blocked" },
          ]}
          onChange={(value) =>
            props.onResultChange(value as (typeof RESULT_OPTIONS)[number])
          }
          value={props.result}
        />
        <p className="m-0 text-xs text-dashboard-text-muted">
          {data.automation.totalRuns} total · newest first
        </p>
      </div>

      {props.executions.length === 0 ? (
        <Card padding="md">
          <p className="m-0 text-sm text-dashboard-text-muted">
            {data.executions.length === 0
              ? "This automation has not run yet."
              : `No ${props.result} runs in the loaded history.`}
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
                {props.executions.map((execution) => (
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
          Showing the 100 most recent runs.
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
            {execution.automationVersion
              ? ` · Version ${execution.automationVersion}`
              : null}
          </span>
          {execution.error ? (
            <span
              className="mt-1 block truncate text-xs leading-relaxed text-rose-300"
              title={execution.error}
            >
              {execution.error}
            </span>
          ) : null}
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
