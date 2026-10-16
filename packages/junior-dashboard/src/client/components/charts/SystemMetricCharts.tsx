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
  activityChartAverage,
  chartAreaPath,
  chartLinePoints,
  chartPercent,
  ChartBar,
  ChartBucket,
  ChartFrame,
  ChartPoint,
} from "./ActivityChart";
import { ChartHeader } from "./ChartHeader";
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
  const values = days.map((day) => metricValue(day, chart.metric));
  const maximum = Math.max(Number.EPSILON, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = activityChartAverage(values);

  return (
    <Card>
      <ChartHeader title={chart.title} total={chart.format(total)} />
      <div className="px-4 pt-4 pb-3">
        <ChartFrame
          aria-label={`${chart.title} per ${props.bucketUnit === "6hour" ? "6 hours" : props.bucketUnit}`}
          average={{
            color: chart.color,
            format:
              chart.metric === "tokens"
                ? formatActivityChartAverage
                : chart.format,
            unit: timeRangeBucketAverageUnit(props.bucketUnit),
            value: average,
          }}
          buckets={days.map((day) => day.date)}
          className="h-26"
          formatTick={chart.axisFormat}
          lines={
            chart.type === "area" && values.length > 0 ? (
              <>
                <path
                  d={chartAreaPath(values, maximum)}
                  fill={chart.color}
                  fillOpacity={0.08}
                />
                <polyline
                  fill="none"
                  points={chartLinePoints(values, maximum)}
                  stroke={chart.color}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            ) : null
          }
          maximum={maximum}
        >
          {days.map((day, index) => {
            const value = values[index]!;
            const percent = chartPercent(value, maximum);
            return (
              <ChartBucket
                bucket={day.date}
                content={chart.format(value)}
                key={day.date}
                summary={chart.format(value)}
              >
                {chart.type === "bar" ? (
                  <ChartBar
                    className="w-[65%] max-w-2 rounded-t-xs opacity-80"
                    fill={chart.color}
                    percent={percent}
                  />
                ) : (
                  <ChartPoint
                    className={
                      chart.type === "scatter"
                        ? "size-1.75 opacity-75"
                        : "size-1.25 opacity-45"
                    }
                    fill={chart.color}
                    percent={percent}
                  />
                )}
              </ChartBucket>
            );
          })}
        </ChartFrame>
      </div>
    </Card>
  );
}
