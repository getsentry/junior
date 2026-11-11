import type { AutomationExecution } from "@sentry/junior/api/schema";
import { Link } from "react-router";

import { ActivityTooltipRows } from "../../components/charts/ActivityChart";
import { statusDotToneClass } from "../../components/StatusDot";
import {
  Tooltip,
  TooltipContent,
  TooltipTitle,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { formatCostSummary, formatRuntime } from "../../format";
import { cn } from "../../styles";
import {
  automationRunStatusTone,
  formatAutomationRunTime,
} from "./automationFormat";

/** One bar in the strip. `to` makes the bar open that run in place. */
export type AutomationRunStripRun = {
  costUsd?: number;
  durationMs?: number;
  error?: string;
  executedAt: string;
  key: string;
  status: AutomationExecution["status"];
  to?: string;
};

/**
 * Show recent runs as bars, oldest left. Color is the result; height is the
 * duration relative to the slowest run shown. Empty slots keep strips aligned
 * across rows, so a new Automation reads as new, not as healthy.
 */
export function AutomationRunStrip(props: {
  label: string;
  runs: AutomationRunStripRun[];
  size?: "compact" | "default";
  slots: number;
}) {
  const runs = props.runs.slice(-props.slots);
  // Scale by completed runs only. Failures are drawn full height anyway, and a
  // timeout would flatten every healthy bar.
  const slowest = Math.max(
    0,
    ...runs.map((run) =>
      run.status === "completed" ? (run.durationMs ?? 0) : 0,
    ),
  );
  const empty = props.slots - runs.length;
  const compact = props.size !== "default";
  return (
    <div
      aria-label={props.label}
      className={cn(
        // When the strip is wider than its space, clip the oldest runs.
        "flex min-w-0 items-end justify-end overflow-hidden [&>*]:shrink-0",
        compact ? "h-5 gap-0.5" : "h-16 gap-1",
      )}
      role="img"
    >
      {Array.from({ length: empty }, (_, index) => (
        <span
          aria-hidden="true"
          className={cn(
            "h-0.5 rounded-full bg-dashboard-fill-strong",
            compact ? "w-1" : "w-2",
          )}
          key={`empty-${index}`}
        />
      ))}
      {runs.map((run) => {
        // Failures fill the strip so they read at a glance.
        const height =
          run.status !== "completed" || !slowest || run.durationMs === undefined
            ? 100
            : Math.max(30, Math.round((run.durationMs / slowest) * 100));
        const label = `${run.status} · ${formatAutomationRunTime(run.executedAt)}`;
        const className = cn(
          "block rounded-[1px] opacity-80 transition-opacity hover:opacity-100 data-popup-open:opacity-100",
          compact ? "w-1" : "w-2",
          statusDotToneClass[automationRunStatusTone(run.status)],
        );
        const style = { height: `${height}%` };
        return (
          <Tooltip key={run.key}>
            <TooltipTrigger
              render={
                run.to ? (
                  <Link
                    aria-label={`Open ${label}`}
                    className={cn(
                      className,
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
                    )}
                    // Bars open run details over the current page.
                    replace
                    style={style}
                    to={run.to}
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className={className}
                    style={style}
                  />
                )
              }
            />
            <TooltipContent>
              <RunTooltip run={run} />
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** The standard chart tooltip for one run: when, result, time, and cost. */
function RunTooltip({ run }: { run: AutomationRunStripRun }) {
  const result = run.status.charAt(0).toUpperCase() + run.status.slice(1);
  const rows: Array<[string, string]> = [["Result", result]];
  if (run.durationMs !== undefined) {
    rows.push(["Duration", formatRuntime(run.durationMs)]);
  }
  if (run.costUsd !== undefined) {
    rows.push(["Cost", formatCostSummary({ total: run.costUsd })]);
  }
  return (
    <>
      <TooltipTitle>{formatAutomationRunTime(run.executedAt)}</TooltipTitle>
      <ActivityTooltipRows rows={rows} />
      {run.error ? (
        <p className="m-0 mt-1.5 line-clamp-3 max-w-64 text-rose-300">
          {run.error}
        </p>
      ) : null}
    </>
  );
}
