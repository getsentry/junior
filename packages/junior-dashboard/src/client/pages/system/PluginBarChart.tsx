import type { PluginOperationalReport } from "@sentry/junior/api/schema";

import {
  ChartAxisLabel,
  ChartCategoryLabels,
  ChartSvg,
  createActivityChartLayout,
  formatActivityCategoryTooltipLabel,
  isActivityHourBucket,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Tooltip } from "../../components/Tooltip";
import { formatCostSummary } from "../../format";

type Widget = NonNullable<PluginOperationalReport["widgets"]>[number];

const colors = [
  "var(--color-cyan-300)",
  "var(--color-emerald-300)",
  "var(--color-amber-400)",
  "var(--color-rose-400)",
  "var(--color-violet-400)",
] as const;
const toneColors = {
  danger: "var(--color-rose-400)",
  good: "var(--color-emerald-300)",
  neutral: "var(--color-cyan-300)",
  warning: "var(--color-amber-400)",
} as const;

function seriesColor(series: Widget["series"][number], index: number): string {
  return series.tone
    ? toneColors[series.tone]
    : (colors[index % colors.length] ?? colors[0]);
}

/** Render a validated plugin-owned categorical bar chart. */
export function PluginBarChart(props: {
  range?: TimeRangeDays;
  widget: Widget;
}) {
  const { widget } = props;
  const categories = widget.timeRangeDays
    ? widget.categories.slice(-visibleCategoryCount(widget, props.range))
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
    <div className="overflow-hidden rounded-md border border-dashboard-border bg-dashboard-surface-panel">
      <div className="border-b border-dashboard-border-subtle px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h4 className="m-0 font-sans text-xs font-medium text-dashboard-text-muted">
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
              color: seriesColor(series, index),
              key: series.key,
              label: series.label,
            }))}
          />
        ) : null}
      </div>
      {categories.length === 0 ? (
        <p className="m-0 p-4 font-sans text-xs text-dashboard-text-muted">
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
                  stroke="var(--color-dashboard-border-subtle)"
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
                  label={formatActivityCategoryTooltipLabel(category.label)}
                >
                  <rect
                    aria-label={`${formatActivityCategoryTooltipLabel(category.label)}, ${series.label}: ${formatted}`}
                    fill={seriesColor(series, seriesIndex)}
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
            layout={layout}
            xPosition={(index) => layout.left + index * step + step / 2}
          />
        </ChartSvg>
      )}
    </div>
  );
}

/** Trailing hour categories for a 24h plugin chart window. */
const HOURLY_CATEGORY_COUNT = 24;

/**
 * How many trailing categories to show for the page range.
 * `1` means last 24 hours: take 24 hour buckets when present, else the
 * shortest multi-day window (daily widgets cannot plot true hourly bars).
 */
function visibleCategoryCount(
  widget: Widget,
  range: TimeRangeDays | undefined,
): number {
  const availableRanges = (widget.timeRangeDays ?? []) as TimeRangeDays[];
  const firstCategory = widget.categories[0];
  const firstKey = firstCategory?.id || firstCategory?.label || "";
  const hasHourBuckets = isActivityHourBucket(firstKey);
  if (range === 1) {
    if (hasHourBuckets && availableRanges.includes(1)) {
      return HOURLY_CATEGORY_COUNT;
    }
    // TODO: ship hour categories from daily-only plugin widgets so 24h can
    // plot true hourly bars instead of falling back to 7d/30d day series.
    if (availableRanges.includes(7)) return 7;
    return availableRanges.includes(30) ? 30 : (availableRanges[0] ?? 30);
  }
  if (range && availableRanges.includes(range)) return range;
  return availableRanges.includes(30) ? 30 : (availableRanges[0] ?? 30);
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
