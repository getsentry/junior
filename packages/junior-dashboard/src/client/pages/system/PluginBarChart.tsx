import type { PluginOperationalReport } from "@sentry/junior/api/schema";

import {
  ActivityTooltipRows,
  ChartBucket,
  ChartFrame,
  chartPercent,
  chartY,
  isActivityHourBucket,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
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
    ? widget.categories.slice(-visibleCategoryCount(widget, props.range))
    : widget.categories;
  const seriesFormat = commonSeriesFormat(widget);
  const values = categories.flatMap((category) =>
    widget.series.map((series) => category.values[series.key] ?? 0),
  );
  const minimum = Math.min(0, ...values);
  const dataMaximum = Math.max(0, ...values);
  const maximum = dataMaximum === minimum ? minimum + 1 : dataMaximum;
  // Bars grow up or down from the zero line.
  const zero = chartY(0, maximum, minimum) * 100;

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
        <p className="m-0 p-4 font-sans text-xs text-dashboard-text-muted">
          {widget.emptyText ?? "No chart data."}
        </p>
      ) : (
        <div className="px-4 pt-4 pb-3">
          <ChartFrame
            aria-label={widget.title}
            buckets={categories.map((category) => category.label)}
            className="h-44"
            formatTick={(value) => formatChartValue(value, seriesFormat)}
            labelAlign="center"
            maximum={maximum}
            minimum={minimum}
          >
            {categories.map((category) => (
              <ChartBucket
                bucket={category.label}
                content={
                  <ActivityTooltipRows
                    rows={widget.series.map((series) => [
                      series.label,
                      formatChartValue(
                        category.values[series.key] ?? 0,
                        series.format,
                      ),
                    ])}
                  />
                }
                key={category.id}
                summary={widget.series
                  .map(
                    (series) =>
                      `${series.label}: ${formatChartValue(category.values[series.key] ?? 0, series.format)}`,
                  )
                  .join(", ")}
              >
                <span className="relative flex h-full w-[72%] max-w-18 gap-[25%]">
                  {widget.series.map((series, seriesIndex) => {
                    const value = category.values[series.key] ?? 0;
                    return (
                      <span
                        className="relative h-full min-w-0 flex-1"
                        key={series.key}
                      >
                        {value ? (
                          <span
                            className="absolute inset-x-0 block min-h-0.5 rounded-t-xs opacity-82"
                            style={{
                              background: series.tone
                                ? toneColors[series.tone]
                                : colors[seriesIndex % colors.length],
                              height: `${chartPercent(value, maximum, minimum)}%`,
                              ...(value >= 0
                                ? { bottom: `${100 - zero}%` }
                                : { top: `${zero}%` }),
                            }}
                          />
                        ) : null}
                      </span>
                    );
                  })}
                </span>
              </ChartBucket>
            ))}
          </ChartFrame>
        </div>
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
