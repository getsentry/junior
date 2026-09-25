import {
  timeRangeBucketAverageUnit,
  type TimeRangeBucketUnit,
} from "../controls/TimeRangeSelector";
import type { ConversationMetricDay } from "@sentry/junior/api/schema";

import { formatDuration } from "../Duration";
import { Card } from "../layout/Card";
import {
  formatActivityChartAverage,
  formatCompactNumber,
  formatCostSummary,
} from "../../format";
import {
  ActivityChartAverageLine,
  ActivityChartDateLabels,
  ActivityChartGrid,
  ActivityChartTooltip,
  activityChartAverage,
  ChartSvg,
} from "./ActivityChart";
import { ChartHeader } from "./ChartHeader";
import { useChartLayout } from "./useChartLayout";
import { InputCacheChart } from "./InputCacheChart";

type Metric = "costUsd" | "durationMs" | "tokens";

type ChartConfig = {
  axisFormat(value: number): string;
  color: string;
  format(value: number): string;
  metric: Metric;
  title: string;
  type: "area" | "bar" | "scatter";
};

function compactCurrency(value: number): string {
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${formatCompactNumber(value)}`;
}

function compactDuration(value: number): string {
  const hours = value / (60 * 60 * 1_000);
  if (hours >= 24) return `${formatCompactNumber(hours / 24)}d`;
  if (hours >= 1) return `${formatCompactNumber(hours)}h`;
  return formatDuration(value);
}

function tokenChart(): ChartConfig {
  return {
    axisFormat: formatCompactNumber,
    color: "#22d3ee",
    format: formatCompactNumber,
    metric: "tokens",
    title: "Token usage",
    type: "bar",
  };
}

function supportingCharts(): ChartConfig[] {
  return [
    {
      axisFormat: compactCurrency,
      color: "#fbbf24",
      format: (value) => formatCostSummary({ total: value }),
      metric: "costUsd",
      title: "Model spend",
      type: "area",
    },
    {
      axisFormat: compactDuration,
      color: "#a78bfa",
      format: formatDuration,
      metric: "durationMs",
      title: "Runtime",
      type: "scatter",
    },
  ];
}

function metricValue(day: ConversationMetricDay, metric: Metric): number {
  return day[metric] ?? 0;
}

/** Plot model usage, spend, and runtime in complementary chart forms. */
export function SystemMetricCharts(props: {
  bucketUnit?: TimeRangeBucketUnit;
  cacheBreakdown?: boolean;
  days: ConversationMetricDay[];
}) {
  const bucketUnit = props.bucketUnit ?? "day";
  const charts = props.cacheBreakdown
    ? supportingCharts()
    : [tokenChart(), ...supportingCharts()];
  return (
    <div className="grid gap-4">
      {props.cacheBreakdown ? (
        <InputCacheChart bucketUnit={bucketUnit} days={props.days} />
      ) : null}
      <div
        className={
          props.cacheBreakdown
            ? "grid gap-4 lg:grid-cols-2"
            : "grid gap-4 lg:grid-cols-3"
        }
      >
        {charts.map((chart) => (
          <MetricChart
            bucketUnit={bucketUnit}
            chart={chart}
            days={props.days}
            key={chart.metric}
          />
        ))}
      </div>
    </div>
  );
}

function MetricChart(props: {
  bucketUnit: TimeRangeBucketUnit;
  chart: ChartConfig;
  days: ConversationMetricDay[];
}) {
  const { chart, days } = props;
  const { ref, layout } = useChartLayout(
    150,
    chart.metric === "costUsd" ? 72 : 64,
  );
  const values = days.map((day) => metricValue(day, chart.metric));
  const maximum = Math.max(Number.EPSILON, ...values);
  const step = layout.plotWidth / Math.max(1, days.length);
  const points = values.map((value, index) => ({
    x: layout.left + step * index + step / 2,
    y: layout.top + layout.plotHeight - (value / maximum) * layout.plotHeight,
  }));
  const area = points.length
    ? `M ${points[0]!.x} ${layout.top + layout.plotHeight} L ${points
        .map((point) => `${point.x} ${point.y}`)
        .join(" L ")} L ${points.at(-1)!.x} ${layout.top + layout.plotHeight} Z`
    : "";
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = activityChartAverage(values);
  const barWidth = Math.max(1.5, Math.min(8, step * 0.65));

  return (
    <Card>
      <ChartHeader title={chart.title} total={chart.format(total)} />
      <div className="px-2 py-2" ref={ref}>
        <ChartSvg
          aria-label={`${chart.title} per ${props.bucketUnit === "6hour" ? "6 hours" : props.bucketUnit}`}
          layout={layout}
        >
          <ActivityChartGrid
            format={chart.axisFormat}
            layout={layout}
            maximum={maximum}
          />
          {chart.type === "area" && area ? (
            <>
              <path d={area} fill={chart.color} fillOpacity={0.08} />
              <polyline
                fill="none"
                points={points
                  .map((point) => `${point.x},${point.y}`)
                  .join(" ")}
                stroke={chart.color}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
              />
            </>
          ) : null}
          {days.map((day, index) => {
            const value = values[index]!;
            const point = points[index]!;
            const barHeight = (value / maximum) * layout.plotHeight;
            const renderedBarHeight = Math.max(value ? 2 : 0, barHeight);
            return (
              <ActivityChartTooltip
                key={day.date}
                content={chart.format(value)}
                date={day.date}
                summary={chart.format(value)}
              >
                {chart.type === "bar" ? (
                  <rect
                    fill={chart.color}
                    height={renderedBarHeight}
                    opacity={value ? 0.8 : 0.1}
                    rx="1.5"
                    tabIndex={0}
                    width={barWidth}
                    x={point.x - barWidth / 2}
                    y={layout.top + layout.plotHeight - renderedBarHeight}
                  />
                ) : (
                  <circle
                    cx={point.x}
                    cy={point.y}
                    fill={chart.color}
                    opacity={chart.type === "scatter" ? 0.75 : 0.45}
                    r={chart.type === "scatter" ? 3.5 : 2.5}
                    tabIndex={0}
                  />
                )}
              </ActivityChartTooltip>
            );
          })}
          <ActivityChartAverageLine
            average={average}
            format={
              chart.metric === "tokens"
                ? formatActivityChartAverage
                : chart.format
            }
            layout={layout}
            maximum={maximum}
            stroke={chart.color}
            unit={timeRangeBucketAverageUnit(props.bucketUnit)}
          />
          <ActivityChartDateLabels
            dates={days.map((day) => day.date)}
            layout={layout}
            xPosition={(index) => points[index]?.x ?? layout.left}
          />
        </ChartSvg>
      </div>
    </Card>
  );
}
