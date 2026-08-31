import type { PluginOperationalReport } from "@sentry/junior/api/schema";

import {
  ChartAxisLabel,
  ChartCategoryLabels,
  ChartSvg,
  createActivityChartLayout,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Tooltip } from "../../components/Tooltip";
import { formatCostSummary } from "../../format";

type Widget = NonNullable<PluginOperationalReport["widgets"]>[number];

const colors = ["#67e8f9", "#6ee7b7", "#fbbf24", "#fb7185", "#a78bfa"] as const;
const toneColors = {
  danger: "#fb7185",
  good: "#6ee7b7",
  neutral: "#67e8f9",
  warning: "#fbbf24",
} as const;

/** Render a validated plugin-owned categorical bar chart. */
export function PluginBarChart(props: {
  range?: TimeRangeDays;
  widget: Widget;
}) {
  const { widget } = props;
  const categories = widget.timeRangeDays
    ? widget.categories.slice(-supportedRange(widget, props.range))
    : widget.categories;
  const seriesFormat = commonSeriesFormat(widget);
  const layout = createActivityChartLayout(250, {
    bottom: 36,
    left: seriesFormat === "usd" ? 104 : 56,
    right: 12,
    top: 16,
    width: 520,
  });
  const step = layout.plotWidth / Math.max(1, categories.length);
  const groupWidth = Math.min(72, step * 0.72);
  const barWidth = groupWidth / Math.max(1, widget.series.length);
  const values = categories.flatMap((category) =>
    widget.series.map((series) => category.values[series.key] ?? 0),
  );
  const minimum = Math.min(0, ...values);
  const dataMaximum = Math.max(0, ...values);
  const maximum = dataMaximum === minimum ? minimum + 1 : dataMaximum;
  const span = maximum - minimum;
  const zeroY = layout.top + (maximum / span) * layout.plotHeight;

  return (
    <div className="overflow-hidden rounded border border-white/[0.07] bg-dashboard-surface-panel">
      <div className="border-b border-white/[0.06] px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h4 className="m-0 font-mono text-xs font-medium uppercase tracking-[0.14em] text-dashboard-text-muted">
            {widget.title}
          </h4>
        </div>
        {widget.description ? (
          <p className="mt-1 mb-0 font-mono text-xs text-dashboard-text-muted">
            {widget.description}
          </p>
        ) : null}
        {widget.series.length > 1 ? (
          <ChartLegend
            ariaLabel="Chart legend"
            items={widget.series.map((series, index) => ({
              color: series.tone
                ? toneColors[series.tone]
                : colors[index % colors.length],
              key: series.key,
              label: series.label,
            }))}
          />
        ) : null}
      </div>
      {categories.length === 0 ? (
        <p className="m-0 p-4 font-mono text-xs text-dashboard-text-muted">
          {widget.emptyText ?? "No chart data."}
        </p>
      ) : (
        <ChartSvg
          aria-label={widget.title}
          className="min-h-48"
          layout={layout}
        >
          {[maximum, maximum - span / 2, minimum].map((tickValue, index) => {
            const y = layout.top + index * (layout.plotHeight / 2);
            return (
              <g key={index}>
                <line
                  stroke="rgba(255,255,255,0.07)"
                  strokeDasharray="3 5"
                  x1={layout.left}
                  x2={layout.width - layout.right}
                  y1={y}
                  y2={y}
                />
                <ChartAxisLabel textAnchor="end" x={layout.left - 6} y={y + 3}>
                  {formatChartValue(tickValue, seriesFormat)}
                </ChartAxisLabel>
              </g>
            );
          })}
          {categories.flatMap((category, categoryIndex) =>
            widget.series.map((series, seriesIndex) => {
              const value = category.values[series.key] ?? 0;
              const renderedHeight = Math.max(
                value ? 2 : 0,
                (Math.abs(value) / span) * layout.plotHeight,
              );
              const formatted = formatChartValue(value, series.format);
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
                    tabIndex={value ? 0 : -1}
                    width={barWidth * 0.75}
                    x={
                      layout.left +
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
          <ChartCategoryLabels
            categories={categories}
            formatLabel={formatCategoryLabel}
            layout={layout}
            xPosition={(index) => layout.left + index * step + step / 2}
          />
        </ChartSvg>
      )}
    </div>
  );
}

function supportedRange(widget: Widget, range: TimeRangeDays | undefined) {
  const availableRanges = widget.timeRangeDays ?? [];
  if (
    range &&
    range !== 1 &&
    (availableRanges as TimeRangeDays[]).includes(range)
  ) {
    return range;
  }
  // Plugin widgets are still daily series; map 24h onto the shortest day window.
  if (range === 1 && availableRanges.includes(7)) return 7;
  return availableRanges.includes(30) ? 30 : (availableRanges[0] ?? 30);
}

function formatCategoryLabel(label: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(label)) {
    return new Date(`${label}:00:00.000Z`).toLocaleTimeString(undefined, {
      hour: "numeric",
      timeZone: "UTC",
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) return label;
  return new Date(`${label}T00:00:00.000Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function formatChartNumber(value: number): string {
  return String(Number(value.toPrecision(12)));
}

function commonSeriesFormat(widget: Widget): "usd" | undefined {
  const formats = new Set(widget.series.map((series) => series.format));
  return formats.size === 1 ? widget.series[0]?.format : undefined;
}

function formatChartValue(value: number, format: "usd" | undefined): string {
  return format === "usd"
    ? formatCostSummary({ total: value })
    : formatChartNumber(value);
}
