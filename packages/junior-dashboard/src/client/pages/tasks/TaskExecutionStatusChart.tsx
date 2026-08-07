import { useState } from "react";
import type { TaskExecutionStatusDay } from "@sentry/junior/api/schema";
import {
  ActivityChartDateLabels,
  ActivityChartGrid,
  ActivityTooltipRows,
  createActivityChartLayout,
  formatActivityDate,
} from "../../components/charts/ActivityChart";
import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";
import { cn } from "../../styles";

type ChartRange = 7 | 30 | 90;

const series = [
  { color: "#6ee7b7", key: "completed", label: "Completed" },
  { color: "#fda4af", key: "failed", label: "Failed" },
  { color: "#fcd34d", key: "blocked", label: "Blocked" },
] as const;

/** Render one task's terminal executions stacked by status over a trailing window. */
export function TaskExecutionStatusChart(props: {
  days: TaskExecutionStatusDay[];
}) {
  const [range, setRange] = useState<ChartRange>(30);
  const days = props.days.slice(-range);
  const layout = createActivityChartLayout(220);
  const totals = days.map(
    (day) => day.completed + day.failed + day.blocked,
  );
  const maximum = Math.max(1, ...totals);
  const step = days.length > 0 ? layout.plotWidth / days.length : layout.plotWidth;
  const barWidth = Math.max(2, Math.min(13, step * 0.68));
  const hasExecutions = totals.some((total) => total > 0);

  return (
    <Card className="min-h-[15rem] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
            Executions over time
          </h2>
          <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
            Terminal runs for this task each day.
          </p>
        </div>
        <div
          aria-label="Task execution range"
          className="inline-flex rounded border border-white/[0.08] bg-black/20 p-0.5"
        >
          {([7, 30, 90] as const).map((daysOption) => (
            <button
              aria-pressed={range === daysOption}
              className={cn(
                "cursor-pointer rounded-sm border-0 px-2.5 py-1.5 font-mono text-xs uppercase tracking-[0.1em] transition-colors",
                range === daysOption
                  ? "bg-cyan-300/10 text-cyan-100"
                  : "bg-transparent text-dashboard-text-muted hover:text-dashboard-text",
              )}
              key={daysOption}
              onClick={() => setRange(daysOption)}
              type="button"
            >
              {daysOption}d
            </button>
          ))}
        </div>
      </div>

      <div
        aria-label="Task execution status legend"
        className="mt-4 flex flex-wrap gap-4"
      >
        {series.map((item) => (
          <span
            className="inline-flex items-center gap-1.5 font-mono text-xs text-dashboard-text-muted"
            key={item.key}
          >
            <i
              className="size-2 rounded-sm"
              style={{ backgroundColor: item.color }}
            />
            {item.label}
          </span>
        ))}
      </div>

      <div className="relative mt-3 overflow-hidden">
        <svg
          aria-label={`Task executions during the last ${range} days`}
          className="block h-auto min-h-40 w-full"
          role="img"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
        >
          <ActivityChartGrid layout={layout} maximum={maximum} />
          {days.map((day, dayIndex) => {
            let stackedHeight = 0;
            const x = layout.left + dayIndex * step + (step - barWidth) / 2;
            const total = totals[dayIndex] ?? 0;
            return (
              <Tooltip
                content={
                  <ActivityTooltipRows
                    rows={[
                      ["completed", day.completed],
                      ["failed", day.failed],
                      ["blocked", day.blocked],
                      ["total", total],
                    ]}
                  />
                }
                key={day.date}
                label={formatActivityDate(day.date)}
              >
                <g
                  aria-label={`${formatActivityDate(day.date)}: ${day.completed} completed, ${day.failed} failed, ${day.blocked} blocked, ${total} total`}
                  tabIndex={0}
                >
                  {series.map((item) => {
                    const value = day[item.key];
                    const segmentHeight = (value / maximum) * layout.plotHeight;
                    stackedHeight += segmentHeight;
                    return (
                      <rect
                        fill={item.color}
                        height={segmentHeight}
                        key={item.key}
                        opacity={0.82}
                        rx="1"
                        width={barWidth}
                        x={x}
                        y={layout.top + layout.plotHeight - stackedHeight}
                      />
                    );
                  })}
                  <rect
                    fill="transparent"
                    height={layout.plotHeight}
                    width={Math.max(barWidth, 8)}
                    x={x - (Math.max(barWidth, 8) - barWidth) / 2}
                    y={layout.top}
                  />
                </g>
              </Tooltip>
            );
          })}
          <ActivityChartDateLabels
            dates={days.map((day) => day.date)}
            layout={layout}
            xPosition={(index) => layout.left + index * step + step / 2}
          />
        </svg>
        {!hasExecutions ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-mono text-xs text-dashboard-text-muted">
            No task executions in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
