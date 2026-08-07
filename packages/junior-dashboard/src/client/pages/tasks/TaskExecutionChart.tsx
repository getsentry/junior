import { useState } from "react";
import type { TaskExecutionDay } from "@sentry/junior/api/schema";
import { ActivityTooltipRows } from "../../components/charts/ActivityChart";
import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";
import { cn } from "../../styles";

type ChartRange = 7 | 30 | 90;

const series = [
  { color: "#6ee7b7", key: "scheduled", label: "Scheduled" },
  { color: "#c4b5fd", key: "event", label: "Event" },
] as const;

/** Render successful task executions stacked by type over a trailing window. */
export function TaskExecutionChart(props: { days: TaskExecutionDay[] }) {
  const [range, setRange] = useState<ChartRange>(30);
  const days = props.days.slice(-range);
  const width = 720;
  const height = 200;
  const left = 56;
  const right = 12;
  const top = 14;
  const bottom = 34;
  const plotHeight = height - top - bottom;
  const plotWidth = width - left - right;
  const step = days.length > 0 ? plotWidth / days.length : plotWidth;
  const barWidth = Math.max(2, Math.min(13, step * 0.68));
  const totals = days.map((day) => day.scheduled + day.event);
  const maximum = Math.max(1, ...totals);
  const hasExecutions = totals.some((total) => total > 0);

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono text-xs uppercase tracking-[0.16em] text-cyan-200/65">
            Task executions
          </div>
          <h2 className="mt-1 mb-0 font-display text-xl font-medium text-dashboard-text">
            Activity over time
          </h2>
          <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
            Successful scheduled and event task runs each day.
          </p>
        </div>
        <div
          aria-label="Task execution range"
          className="inline-flex rounded border border-white/[0.08] bg-black/20 p-0.5"
        >
          {([7, 30, 90] as const).map((days) => (
            <button
              aria-pressed={range === days}
              className={cn(
                "cursor-pointer rounded-sm border-0 px-2.5 py-1.5 font-mono text-xs uppercase tracking-[0.1em] transition-colors",
                range === days
                  ? "bg-cyan-300/10 text-cyan-100"
                  : "bg-transparent text-dashboard-text-muted hover:text-dashboard-text",
              )}
              key={days}
              onClick={() => setRange(days)}
              type="button"
            >
              {days}d
            </button>
          ))}
        </div>
      </div>

      <div
        aria-label="Task execution legend"
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
          viewBox={`0 0 ${width} ${height}`}
        >
          {[maximum, maximum / 2, 0].map((value, index) => {
            const y = top + index * (plotHeight / 2);
            return (
              <g key={index}>
                <line
                  stroke="rgba(255,255,255,0.07)"
                  strokeDasharray="3 5"
                  x1={left}
                  x2={width - right}
                  y1={y}
                  y2={y}
                />
                <text
                  fill="rgba(255,255,255,0.34)"
                  fontFamily="ui-monospace, monospace"
                  fontSize="13"
                  textAnchor="end"
                  x={left - 7}
                  y={y + 3}
                >
                  {Math.round(value)}
                </text>
              </g>
            );
          })}
          {days.map((day, dayIndex) => {
            let stackedHeight = 0;
            const x = left + dayIndex * step + (step - barWidth) / 2;
            const total = totals[dayIndex] ?? 0;
            return (
              <Tooltip
                content={
                  <ActivityTooltipRows
                    rows={[
                      ["scheduled", day.scheduled],
                      ["event", day.event],
                      ["total", total],
                    ]}
                  />
                }
                key={day.date}
                label={formatDate(day.date)}
              >
                <g
                  aria-label={`${formatDate(day.date)}: ${day.scheduled} scheduled, ${day.event} event, ${total} total executions`}
                  tabIndex={0}
                >
                  {series.map((item) => {
                    const value = day[item.key];
                    const segmentHeight = (value / maximum) * plotHeight;
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
                        y={top + plotHeight - stackedHeight}
                      />
                    );
                  })}
                  <rect
                    fill="transparent"
                    height={plotHeight}
                    width={Math.max(barWidth, 8)}
                    x={x - (Math.max(barWidth, 8) - barWidth) / 2}
                    y={top}
                  />
                </g>
              </Tooltip>
            );
          })}
          {[0, Math.floor((days.length - 1) / 2), days.length - 1].map(
            (index) => {
              const day = days[index];
              if (!day) return null;
              return (
                <text
                  fill="rgba(255,255,255,0.34)"
                  fontFamily="ui-monospace, monospace"
                  fontSize="13"
                  key={day.date}
                  textAnchor={
                    index === 0
                      ? "start"
                      : index === days.length - 1
                        ? "end"
                        : "middle"
                  }
                  x={
                    index === 0
                      ? left
                      : index === days.length - 1
                        ? width - right
                        : left + index * step + step / 2
                  }
                  y={height - 9}
                >
                  {formatDate(day.date)}
                </text>
              );
            },
          )}
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

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}
