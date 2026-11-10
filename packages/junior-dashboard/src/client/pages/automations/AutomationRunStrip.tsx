import type { AutomationExecution } from "@sentry/junior/api/schema";
import { Link } from "react-router";

import { statusDotToneClass } from "../../components/StatusDot";
import { cn } from "../../styles";
import {
  automationRunStatusTone,
  formatAutomationRunTime,
} from "./automationFormat";

/** One bar in the strip. `to` makes the bar open that run. */
export type AutomationRunStripRun = {
  durationMs?: number;
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
        const title = `${run.status} · ${formatAutomationRunTime(run.executedAt)}`;
        const className = cn(
          "block rounded-[1px] opacity-80 transition-opacity hover:opacity-100",
          compact ? "w-1" : "w-2",
          statusDotToneClass[automationRunStatusTone(run.status)],
        );
        return run.to ? (
          <Link
            aria-label={`Open ${title}`}
            className={cn(
              className,
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
            )}
            key={run.key}
            style={{ height: `${height}%` }}
            title={title}
            to={run.to}
          />
        ) : (
          <span
            aria-hidden="true"
            className={className}
            key={run.key}
            style={{ height: `${height}%` }}
            title={title}
          />
        );
      })}
    </div>
  );
}
