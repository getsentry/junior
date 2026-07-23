import type { PluginOperationalReport } from "@sentry/junior/api/schema";

import { Tooltip } from "./Tooltip";

type Widget = NonNullable<PluginOperationalReport["widgets"]>[number];

const colors = ["#67e8f9", "#6ee7b7", "#fbbf24", "#fb7185", "#a78bfa"];
const toneColors = {
  danger: "#fb7185",
  good: "#6ee7b7",
  neutral: "#67e8f9",
  warning: "#fbbf24",
} as const;

/** Render a validated plugin-owned categorical bar chart. */
export function PluginBarChart({ widget }: { widget: Widget }) {
  const width = 520;
  const height = 250;
  const left = 42;
  const top = 16;
  const bottom = 36;
  const plotHeight = height - top - bottom;
  const step = (width - left - 12) / widget.categories.length;
  const groupWidth = Math.min(72, step * 0.72);
  const barWidth = groupWidth / widget.series.length;
  const values = widget.categories.flatMap((category) =>
    widget.series.map((series) => category.values[series.key] ?? 0),
  );
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const span = Math.max(Number.EPSILON, maximum - minimum);
  const zeroY = top + (maximum / span) * plotHeight;

  return (
    <div className="overflow-hidden rounded border border-white/[0.07] bg-[#09090b]">
      <div className="border-b border-white/[0.06] px-4 py-3">
        <h4 className="m-0 font-mono text-[0.68rem] font-medium uppercase tracking-[0.14em] text-white/60">
          {widget.title}
        </h4>
        {widget.description ? (
          <p className="mt-1 mb-0 font-mono text-[0.62rem] text-white/30">
            {widget.description}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-3">
          {widget.series.map((series, index) => (
            <span
              className="flex items-center gap-1.5 font-mono text-[0.58rem] text-white/40"
              key={series.key}
            >
              <i
                className="size-2 rounded-sm"
                style={{
                  backgroundColor: series.tone
                    ? toneColors[series.tone]
                    : colors[index % colors.length],
                }}
              />
              {series.label}
            </span>
          ))}
        </div>
      </div>
      {widget.categories.length === 0 ? (
        <p className="m-0 p-4 font-mono text-[0.68rem] text-white/30">
          {widget.emptyText ?? "No chart data."}
        </p>
      ) : (
        <svg
          aria-label={widget.title}
          className="block h-auto min-h-48 w-full"
          role="img"
          viewBox={`0 0 ${width} ${height}`}
        >
          {[maximum, maximum - span / 2, minimum].map((tickValue, index) => {
            const y = top + index * (plotHeight / 2);
            return (
              <g key={index}>
                <line
                  stroke="rgba(255,255,255,0.07)"
                  strokeDasharray="3 5"
                  x1={left}
                  x2={width - 12}
                  y1={y}
                  y2={y}
                />
                <text
                  fill="rgba(255,255,255,0.35)"
                  fontFamily="ui-monospace, monospace"
                  fontSize="9"
                  textAnchor="end"
                  x={left - 6}
                  y={y + 3}
                >
                  {formatChartNumber(tickValue)}
                </text>
              </g>
            );
          })}
          {widget.categories.flatMap((category, categoryIndex) =>
            widget.series.map((series, seriesIndex) => {
              const value = category.values[series.key] ?? 0;
              const renderedHeight = Math.max(
                value ? 2 : 0,
                (Math.abs(value) / span) * plotHeight,
              );
              const formatted = formatChartNumber(value);
              return (
                <Tooltip
                  content={`${series.label}: ${formatted}`}
                  key={`${category.id}:${series.key}`}
                  label={category.label}
                >
                  <rect
                    aria-label={`${category.label}, ${series.label}: ${formatted}`}
                    fill={
                      series.tone
                        ? toneColors[series.tone]
                        : colors[seriesIndex % colors.length]
                    }
                    height={renderedHeight}
                    opacity={value ? 0.82 : 0.1}
                    rx="1.5"
                    tabIndex={0}
                    width={Math.max(2, barWidth - 2)}
                    x={
                      left +
                      categoryIndex * step +
                      (step - groupWidth) / 2 +
                      seriesIndex * barWidth
                    }
                    y={value >= 0 ? zeroY - renderedHeight : zeroY}
                  />
                </Tooltip>
              );
            }),
          )}
          {widget.categories.map((category, index) => (
            <text
              fill="rgba(255,255,255,0.4)"
              fontFamily="ui-monospace, monospace"
              fontSize="9"
              key={category.id}
              textAnchor="middle"
              x={left + index * step + step / 2}
              y={height - 9}
            >
              {category.label}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

function formatChartNumber(value: number): string {
  return String(value);
}
