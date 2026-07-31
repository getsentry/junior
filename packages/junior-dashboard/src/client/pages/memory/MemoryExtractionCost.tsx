import { useState } from "react";

import { Card } from "../../components/layout/Card";
import { formatCostSummary } from "../../format";
import { cn } from "../../styles";
import type { MemoryExtractionDay } from "./memoryDashboard";

type MemoryRange = 7 | 30 | 90;

/** Render passive memory extraction cost from durable plugin events. */
export function MemoryExtractionCost(props: { days: MemoryExtractionDay[] }) {
  const [range, setRange] = useState<MemoryRange>(30);
  const days = props.days.slice(-range);
  const total = days.reduce((sum, day) => sum + day.costUsd, 0);
  const runs = days.reduce((sum, day) => sum + day.events, 0);
  const maximum = Math.max(0.01, ...days.map((day) => day.costUsd));
  const width = 720;
  const height = 200;
  const left = 48;
  const right = 12;
  const top = 14;
  const bottom = 34;
  const plotHeight = height - top - bottom;
  const step = (width - left - right) / days.length;
  const barWidth = Math.max(2, Math.min(13, step * 0.68));

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-cyan-200/65">
            Extraction cost
          </div>
          <h2 className="mt-1 mb-0 font-display text-xl font-medium text-dashboard-text">
            {formatCostSummary({ total })}
          </h2>
          <p className="mt-1 mb-0 font-mono text-[0.64rem] leading-relaxed text-dashboard-text-muted">
            System-wide estimate across {runs.toLocaleString()} passive runs.
          </p>
        </div>
        <div
          aria-label="Memory extraction cost range"
          className="inline-flex rounded border border-white/[0.08] bg-black/20 p-0.5"
        >
          {([7, 30, 90] as const).map((days) => (
            <button
              aria-pressed={range === days}
              className={cn(
                "cursor-pointer rounded-sm border-0 px-2.5 py-1.5 font-mono text-[0.58rem] uppercase tracking-[0.1em] transition-colors",
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

      <div className="relative mt-4 overflow-hidden">
        <svg
          aria-label={`Memory extraction cost during the last ${range} days`}
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
                  fontSize="9"
                  textAnchor="end"
                  x={left - 7}
                  y={y + 3}
                >
                  {formatCostSummary({ total: value })}
                </text>
              </g>
            );
          })}
          {days.map((day, index) => {
            const height = (day.costUsd / maximum) * plotHeight;
            const x = left + index * step + (step - barWidth) / 2;
            return (
              <rect
                aria-label={`${formatDate(day.date)}: ${formatCostSummary({ total: day.costUsd })}, ${day.events} runs`}
                fill="#67e8f9"
                height={height}
                key={day.date}
                opacity={day.costUsd > 0 ? 0.82 : 0.1}
                rx="1"
                width={barWidth}
                x={x}
                y={top + plotHeight - height}
              >
                <title>{`${formatDate(day.date)}: ${formatCostSummary({ total: day.costUsd })}, ${day.events} runs`}</title>
              </rect>
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
                  fontSize="9"
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
        {runs === 0 ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-mono text-[0.68rem] text-dashboard-text-muted">
            No passive extractions ran in this period.
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
