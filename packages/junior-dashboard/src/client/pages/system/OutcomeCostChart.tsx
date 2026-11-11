import type { ConversationMetricDay } from "@sentry/junior/api/schema";
import { CartesianGrid, ComposedChart, Line } from "recharts";

import { ChartHeader } from "../../components/charts/ChartHeader";
import { ChartLegend } from "../../components/charts/ChartLegend";
import {
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "../../components/charts/ActivityChart";
import {
  timeRangeBucketPerLabel,
  type TimeRangeBucketUnit,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";
import { formatCompactNumber, formatCostSummary } from "../../format";

const SERIES = [
  {
    color: "var(--color-amber-400)",
    key: "outcome",
    label: "Per outcome",
  },
  {
    color: "var(--color-violet-400)",
    key: "merged",
    label: "Per merged change",
  },
] as const;

type Point = {
  date: string;
  merged: number | null;
  mergedCodeChanges: number;
  outcome: number | null;
  outcomes: number;
};

/**
 * Running mean cost from the first bucket through each bucket. One bucket
 * often has no outcome, or one costly merge, so per-bucket ratios are mostly
 * noise. The last point equals the mean of the whole range.
 */
function runningCosts(days: readonly ConversationMetricDay[]): Point[] {
  let outcomes = 0;
  let outcomeCostUsd = 0;
  let mergedCodeChanges = 0;
  let mergedCodeChangeCostUsd = 0;
  return days.map((day) => {
    outcomes += day.outcomes ?? 0;
    outcomeCostUsd += day.outcomeCostUsd ?? 0;
    mergedCodeChanges += day.mergedCodeChanges ?? 0;
    mergedCodeChangeCostUsd += day.mergedCodeChangeCostUsd ?? 0;
    return {
      date: day.date,
      merged: mergedCodeChanges
        ? mergedCodeChangeCostUsd / mergedCodeChanges
        : null,
      mergedCodeChanges,
      outcome: outcomes ? outcomeCostUsd / outcomes : null,
      outcomes,
    };
  });
}

function formatUnitCost(value: number | null): string {
  return value === null ? "—" : formatCostSummary({ total: value });
}

// Unit costs are often a few dollars, so the axis keeps cents.
function formatAxisCost(value: number): string {
  return value < 100
    ? formatCostSummary({ total: value })
    : `$${formatCompactNumber(value)}`;
}

/** Plot the running cost per outcome and per merged code change. */
export function OutcomeCostChart(props: {
  bucketUnit: TimeRangeBucketUnit;
  days: ConversationMetricDay[];
}) {
  const data = runningCosts(props.days);
  const last = data.at(-1);
  const maximum = Math.max(
    Number.EPSILON,
    ...data.flatMap((point) => [point.outcome ?? 0, point.merged ?? 0]),
  );
  return (
    <Card>
      <ChartHeader
        description={`${formatCompactNumber(last?.mergedCodeChanges)} merged changes and ${formatCompactNumber((last?.outcomes ?? 0) - (last?.mergedCodeChanges ?? 0))} answered or done conversations. Running mean over the period.`}
        title="Cost per outcome"
        trailing={
          <ChartLegend
            ariaLabel="Cost per outcome series"
            inline
            items={SERIES.map((series) => ({
              ...series,
              value: formatUnitCost(last?.[series.key] ?? null),
            }))}
          />
        }
      />
      <div className="px-2 py-2">
        <ChartContainer
          className="aspect-auto h-38 w-full"
          config={Object.fromEntries(
            SERIES.map(({ color, key, label }) => [key, { color, label }]),
          )}
        >
          <ComposedChart
            aria-label={`Running cost per outcome per ${timeRangeBucketPerLabel(props.bucketUnit)}`}
            data={data}
            margin={activityChartMargin}
            role="img"
          >
            <CartesianGrid strokeDasharray="3 5" vertical={false} />
            <ActivityChartYAxis format={formatAxisCost} maximum={maximum} />
            <ActivityChartXAxis keys={data.map((point) => point.date)} />
            <ChartTooltip
              content={
                <ActivityChartTooltipContent
                  rows={(point: Point) => [
                    [
                      `Per outcome (${formatCompactNumber(point.outcomes)})`,
                      formatUnitCost(point.outcome),
                    ],
                    [
                      `Per merged change (${formatCompactNumber(point.mergedCodeChanges)})`,
                      formatUnitCost(point.merged),
                    ],
                  ]}
                />
              }
            />
            {SERIES.map((series) => (
              <Line
                dataKey={series.key}
                dot={false}
                isAnimationActive={false}
                key={series.key}
                stroke={`var(--color-${series.key})`}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                type="linear"
              />
            ))}
          </ComposedChart>
        </ChartContainer>
      </div>
    </Card>
  );
}
