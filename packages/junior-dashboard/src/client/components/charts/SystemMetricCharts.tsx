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
import { Area, Bar, CartesianGrid, ComposedChart, Scatter } from "recharts";
import { ChartContainer, ChartTooltip } from "../ui/chart";
import {
  ActivityChartAverageLine,
  activityChartAverage,
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
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
    color: "var(--color-cyan-400)",
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
      color: "var(--color-amber-400)",
      format: (value) => formatCostSummary({ total: value }),
      metric: "costUsd",
      title: "Model spend",
      type: "area",
    },
    {
      axisFormat: compactDuration,
      color: "var(--color-violet-400)",
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
  const data = days.map((day, index) => ({
    date: day.date,
    value: values[index]!,
  }));
  const maximum = Math.max(Number.EPSILON, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = activityChartAverage(values);
  const series = {
    dataKey: "value",
    fill: "var(--color-value)",
    isAnimationActive: false,
  } as const;

  return (
    <Card>
      <ChartHeader title={chart.title} total={chart.format(total)} />
      <div className="px-2 py-2">
        <ChartContainer
          className="aspect-auto h-38 w-full"
          config={{ value: { color: chart.color, label: chart.title } }}
        >
          <ComposedChart
            aria-label={`${chart.title} per ${props.bucketUnit === "6hour" ? "6 hours" : props.bucketUnit}`}
            data={data}
            margin={activityChartMargin}
            role="img"
          >
            <CartesianGrid strokeDasharray="3 5" vertical={false} />
            <ActivityChartYAxis format={chart.axisFormat} maximum={maximum} />
            <ActivityChartXAxis keys={data.map((day) => day.date)} />
            <ChartTooltip
              content={
                <ActivityChartTooltipContent
                  rows={(day: (typeof data)[number]) => [
                    [chart.title, chart.format(day.value)],
                  ]}
                />
              }
            />
            {chart.type === "bar" ? (
              <Bar
                {...series}
                fillOpacity={0.8}
                maxBarSize={8}
                minPointSize={(value) => (value ? 2 : 0)}
                radius={1.5}
              />
            ) : chart.type === "area" ? (
              <Area
                {...series}
                dot={{ fillOpacity: 0.45, r: 2.5, stroke: "none" }}
                fillOpacity={0.08}
                stroke="var(--color-value)"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                type="linear"
              />
            ) : (
              <Scatter {...series} fillOpacity={0.75} />
            )}
            <ActivityChartAverageLine
              average={average}
              format={
                chart.metric === "tokens"
                  ? formatActivityChartAverage
                  : chart.format
              }
              stroke={chart.color}
              unit={timeRangeBucketAverageUnit(props.bucketUnit)}
            />
          </ComposedChart>
        </ChartContainer>
      </div>
    </Card>
  );
}
