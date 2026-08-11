import type { ConversationMetricDay } from "@sentry/junior/api/schema";

import { formatDuration } from "../Duration";
import { Card } from "../layout/Card";
import { Tooltip } from "../Tooltip";
import {
  formatActivityChartAverage,
  formatCompactNumber,
  formatCostSummary,
} from "../../format";
import {
  ActivityChartAverageLine,
  ActivityChartDateLabels,
  ActivityChartGrid,
  ActivityTooltipRows,
  activityChartAverage,
  ChartSvg,
  createActivityChartLayout,
  formatActivityDate,
} from "./ActivityChart";
import { ChartHeader } from "./ChartHeader";
import { ChartLegend } from "./ChartLegend";

type Metric = "costUsd" | "durationMs" | "inputTokens" | "tokens";

type ChartConfig = {
  axisFormat(value: number): string;
  color: string;
  description: string;
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

const tokenChart: ChartConfig = {
  axisFormat: formatCompactNumber,
  color: "#22d3ee",
  description: "Daily model tokens",
  format: formatCompactNumber,
  metric: "tokens",
  title: "Token usage",
  type: "bar",
};

const inputCacheChart: ChartConfig = {
  axisFormat: formatCompactNumber,
  color: "#22d3ee",
  description: "Daily cached and uncached input tokens",
  format: formatCompactNumber,
  metric: "inputTokens",
  title: "Input token cache",
  type: "bar",
};

const supportingCharts: ChartConfig[] = [
  {
    axisFormat: compactCurrency,
    color: "#fbbf24",
    description: "Daily estimated cost",
    format: (value) => formatCostSummary({ total: value }),
    metric: "costUsd",
    title: "Model spend",
    type: "area",
  },
  {
    axisFormat: compactDuration,
    color: "#a78bfa",
    description: "Daily cumulative runtime",
    format: formatDuration,
    metric: "durationMs",
    title: "Runtime",
    type: "scatter",
  },
];

function metricValue(day: ConversationMetricDay, metric: Metric): number {
  if (metric === "inputTokens") {
    return (day.inputTokens ?? 0) + (day.cachedInputTokens ?? 0);
  }
  return day[metric] ?? 0;
}

/** Plot daily model usage, spend, and runtime in complementary chart forms. */
export function SystemMetricCharts(props: {
  cacheBreakdown?: boolean;
  days: ConversationMetricDay[];
}) {
  const charts = [
    props.cacheBreakdown ? inputCacheChart : tokenChart,
    ...supportingCharts,
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {charts.map((chart) => (
        <MetricChart chart={chart} days={props.days} key={chart.metric} />
      ))}
    </div>
  );
}

function MetricChart(props: {
  chart: ChartConfig;
  days: ConversationMetricDay[];
}) {
  const { chart, days } = props;
  const layout = createActivityChartLayout(250, {
    bottom: 34,
    left: chart.metric === "costUsd" ? 80 : 64,
    right: 14,
    top: 22,
    width: 400,
  });
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
      <ChartHeader
        description={chart.description}
        title={chart.title}
        total={chart.format(total)}
      />
      {chart.metric === "inputTokens" ? (
        <div className="px-5 pt-3">
          <ChartLegend
            ariaLabel="Input token cache series"
            inline
            items={[
              { color: "#22d3ee", key: "cached", label: "Cached" },
              { color: "#a78bfa", key: "uncached", label: "Uncached" },
            ]}
          />
        </div>
      ) : null}
      <div className="px-2 py-3">
        <ChartSvg
          aria-label={`${chart.title} per day`}
          className="min-h-52 overflow-hidden"
          layout={layout}
        >
          <defs>
            <linearGradient
              id={`${chart.metric}-area`}
              x1="0"
              x2="0"
              y1="0"
              y2="1"
            >
              <stop offset="0%" stopColor={chart.color} stopOpacity="0.3" />
              <stop offset="100%" stopColor={chart.color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <ActivityChartGrid
            format={chart.axisFormat}
            layout={layout}
            maximum={maximum}
          />
          {chart.type === "area" && area ? (
            <>
              <path d={area} fill={`url(#${chart.metric}-area)`} />
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
              <Tooltip
                content={
                  chart.metric === "inputTokens" ? (
                    <ActivityTooltipRows
                      rows={[
                        [
                          "cached",
                          formatCompactNumber(day.cachedInputTokens ?? 0),
                        ],
                        ["uncached", formatCompactNumber(day.inputTokens ?? 0)],
                      ]}
                    />
                  ) : (
                    chart.format(value)
                  )
                }
                key={day.date}
                label={formatActivityDate(day.date)}
              >
                {chart.type === "bar" && chart.metric === "inputTokens" ? (
                  <g
                    aria-label={`${formatActivityDate(day.date)}: ${chart.format(value)} input tokens`}
                    tabIndex={0}
                  >
                    <rect
                      fill="#a78bfa"
                      height={renderedBarHeight}
                      opacity={value ? 0.8 : 0.1}
                      rx="1.5"
                      width={barWidth}
                      x={point.x - barWidth / 2}
                      y={layout.top + layout.plotHeight - renderedBarHeight}
                    />
                    <rect
                      fill="#22d3ee"
                      height={
                        value
                          ? ((day.cachedInputTokens ?? 0) / value) *
                            renderedBarHeight
                          : 0
                      }
                      opacity={0.85}
                      rx="1.5"
                      width={barWidth}
                      x={point.x - barWidth / 2}
                      y={layout.top + layout.plotHeight - renderedBarHeight}
                    />
                  </g>
                ) : chart.type === "bar" ? (
                  <rect
                    aria-label={`${formatActivityDate(day.date)}: ${chart.format(value)}`}
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
                    aria-label={`${formatActivityDate(day.date)}: ${chart.format(value)}`}
                    cx={point.x}
                    cy={point.y}
                    fill={chart.color}
                    opacity={chart.type === "scatter" ? 0.75 : 0.45}
                    r={chart.type === "scatter" ? 3.5 : 2.5}
                    tabIndex={0}
                  />
                )}
              </Tooltip>
            );
          })}
          <ActivityChartAverageLine
            average={average}
            format={
              chart.metric === "inputTokens" || chart.metric === "tokens"
                ? formatActivityChartAverage
                : chart.format
            }
            layout={layout}
            maximum={maximum}
            stroke={chart.color}
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
