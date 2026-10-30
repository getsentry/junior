import type { PluginOperationalReport } from "@sentry/junior/api/schema";

import { Bar, BarChart, CartesianGrid } from "recharts";
import {
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
  formatActivityCategoryLabel,
  formatActivityCategoryTooltipLabel,
  isActivityHourBucket,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";
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

/**
 * Pick the categories a plugin chart shows for the page range and the value
 * scale they need. The scale always includes zero and is never empty.
 */
export function pluginChartScale(widget: Widget, range?: TimeRangeDays) {
  const categories = widget.timeRangeDays
    ? widget.categories.slice(-visibleCategoryCount(widget, range))
    : widget.categories;
  const values = categories.flatMap((category) =>
    widget.series.map((series) => category.values[series.key] ?? 0),
  );
  const minimum = Math.min(0, ...values);
  const dataMaximum = Math.max(0, ...values);
  const maximum = dataMaximum === minimum ? minimum + 1 : dataMaximum;
  return { categories, maximum, minimum };
}

/** Render a validated plugin-owned categorical bar chart. */
export function PluginBarChart(props: {
  range?: TimeRangeDays;
  widget: Widget;
}) {
  const { widget } = props;
  const { categories, maximum, minimum } = pluginChartScale(
    widget,
    props.range,
  );
  const seriesFormat = commonSeriesFormat(widget);
  // Series keys come from plugins, so chart keys use the series index.
  const data = categories.map((category) => ({
    category,
    id: category.id,
    ...Object.fromEntries(
      widget.series.map((series, index) => [
        `series-${index}`,
        category.values[series.key] ?? 0,
      ]),
    ),
  }));
  const labels = new Map(
    categories.map((category) => [category.id, category.label]),
  );
  const chartConfig = Object.fromEntries(
    widget.series.map((series, index) => [
      `series-${index}`,
      { color: seriesColor(series, index), label: series.label },
    ]),
  );

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
        <ChartContainer
          className="aspect-auto h-60 w-full"
          config={chartConfig}
        >
          <BarChart
            aria-label={widget.title}
            data={data}
            margin={activityChartMargin}
            role="img"
          >
            <CartesianGrid strokeDasharray="3 5" vertical={false} />
            <ActivityChartYAxis
              format={(value) => formatChartValue(value, seriesFormat)}
              maximum={maximum}
              minimum={minimum}
            />
            <ActivityChartXAxis
              centered
              dataKey="id"
              formatLabel={(id) =>
                formatActivityCategoryLabel(labels.get(id) ?? id)
              }
              keys={categories.map((category) => category.id)}
            />
            <ChartTooltip
              content={
                <ActivityChartTooltipContent
                  formatLabel={(id) =>
                    formatActivityCategoryTooltipLabel(labels.get(id) ?? id)
                  }
                  rows={({ category }: (typeof data)[number]) =>
                    widget.series.map((series) => [
                      series.label,
                      formatChartValue(
                        category.values[series.key] ?? 0,
                        series.format,
                      ),
                    ])
                  }
                />
              }
            />
            {widget.series.map((series, index) => (
              <Bar
                dataKey={`series-${index}`}
                fill={`var(--color-series-${index})`}
                fillOpacity={0.82}
                isAnimationActive={false}
                key={series.key}
                maxBarSize={54 / widget.series.length}
                minPointSize={(value) => (value ? 2 : 0)}
                radius={1.5}
              />
            ))}
          </BarChart>
        </ChartContainer>
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

/** Format a plugin chart value as USD or as a number without float noise. */
export function formatChartValue(
  value: number,
  format: "usd" | undefined,
): string {
  return format === "usd"
    ? formatCostSummary({ total: value })
    : formatChartNumber(value);
}
