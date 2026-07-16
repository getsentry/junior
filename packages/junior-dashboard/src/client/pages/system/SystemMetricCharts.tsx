import type { ConversationMetricDay } from "@sentry/junior/api/schema";

import { formatDuration } from "../../components/Duration";
import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";
import { formatCompactNumber, formatCostSummary } from "../../format";

type Metric = "costUsd" | "durationMs" | "tokens";

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

const charts: ChartConfig[] = [
  {
    axisFormat: formatCompactNumber,
    color: "#22d3ee",
    description: "Daily model tokens consumed across completed work.",
    format: formatCompactNumber,
    metric: "tokens",
    title: "Token usage",
    type: "bar",
  },
  {
    axisFormat: compactCurrency,
    color: "#fbbf24",
    description: "Daily estimated model cost in US dollars.",
    format: (value) => formatCostSummary({ total: value }),
    metric: "costUsd",
    title: "Model spend",
    type: "area",
  },
  {
    axisFormat: compactDuration,
    color: "#a78bfa",
    description: "Daily cumulative runtime, with outliers left visible.",
    format: formatDuration,
    metric: "durationMs",
    title: "Runtime",
    type: "scatter",
  },
];

function shortDate(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function metricValue(day: ConversationMetricDay, metric: Metric): number {
  return day[metric] ?? 0;
}

/** Plot daily model usage, spend, and runtime in complementary chart forms. */
export function SystemMetricCharts(props: { days: ConversationMetricDay[] }) {
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
  const width = 400;
  const height = 250;
  const left = 48;
  const right = 14;
  const top = 22;
  const bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const values = days.map((day) => metricValue(day, chart.metric));
  const maximum = Math.max(Number.EPSILON, ...values);
  const step = plotWidth / Math.max(1, days.length);
  const points = values.map((value, index) => ({
    x: left + step * index + step / 2,
    y: top + plotHeight - (value / maximum) * plotHeight,
  }));
  const area = points.length
    ? `M ${points[0]!.x} ${top + plotHeight} L ${points
        .map((point) => `${point.x} ${point.y}`)
        .join(" L ")} L ${points.at(-1)!.x} ${top + plotHeight} Z`
    : "";
  const labels = [0, Math.floor((days.length - 1) / 2), days.length - 1].filter(
    (index, position, indexes) =>
      index >= 0 && indexes.indexOf(index) === position,
  );
  const total = values.reduce((sum, value) => sum + value, 0);
  const barWidth = Math.max(1.5, Math.min(8, step * 0.65));

  return (
    <Card>
      <div className="border-b border-white/[0.06] px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="m-0 font-mono text-[0.68rem] font-medium uppercase tracking-[0.14em] text-white/60">
              {chart.title}
            </h3>
            <p className="mt-1 mb-0 font-mono text-[0.64rem] leading-relaxed text-white/35">
              {chart.description}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-display text-xl font-light text-white/90">
              {chart.format(total)}
            </div>
            <div className="font-mono text-[0.56rem] uppercase tracking-[0.1em] text-white/25">
              period total
            </div>
          </div>
        </div>
      </div>
      <div className="px-2 py-3">
        <svg
          aria-label={`${chart.title} per day`}
          className="block h-auto min-h-52 w-full overflow-hidden"
          role="img"
          viewBox={`0 0 ${width} ${height}`}
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
          {[0, 0.5, 1].map((ratio) => {
            const y = top + ratio * plotHeight;
            return (
              <g key={ratio}>
                <line
                  stroke="rgba(255,255,255,0.07)"
                  strokeDasharray="3 5"
                  x1={left}
                  x2={width - right}
                  y1={y}
                  y2={y}
                />
                <text
                  fill="rgba(255,255,255,0.35)"
                  fontFamily="ui-monospace, monospace"
                  fontSize="9"
                  textAnchor="end"
                  x={left - 7}
                  y={y + 3}
                >
                  {chart.axisFormat(maximum * (1 - ratio))}
                </text>
              </g>
            );
          })}
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
            const barHeight = (value / maximum) * plotHeight;
            const renderedBarHeight = Math.max(value ? 2 : 0, barHeight);
            return (
              <Tooltip
                content={chart.format(value)}
                key={day.date}
                label={shortDate(day.date)}
              >
                {chart.type === "bar" ? (
                  <rect
                    aria-label={`${shortDate(day.date)}: ${chart.format(value)}`}
                    fill={chart.color}
                    height={renderedBarHeight}
                    opacity={value ? 0.8 : 0.1}
                    rx="1.5"
                    tabIndex={0}
                    width={barWidth}
                    x={point.x - barWidth / 2}
                    y={top + plotHeight - renderedBarHeight}
                  />
                ) : (
                  <circle
                    aria-label={`${shortDate(day.date)}: ${chart.format(value)}`}
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
          {labels.map((index) => {
            const day = days[index];
            const point = points[index];
            if (!day || !point) return null;
            return (
              <text
                fill="rgba(255,255,255,0.35)"
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
                x={point.x}
                y={height - 8}
              >
                {shortDate(day.date)}
              </text>
            );
          })}
        </svg>
      </div>
    </Card>
  );
}
