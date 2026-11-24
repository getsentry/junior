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
    color: "var(--color-violet-400)",
    key: "merged",
    label: "Per merged change",
  },
  {
    color: "var(--color-amber-400)",
    key: "allSpend",
    label: "All spend",
  },
] as const;

type Point = {
  /** All model spend over merged changes, including spend of no merge. */
  allSpend: number | null;
  date: string;
  merged: number | null;
  mergedCodeChanges: number;
};

// Each scale smooths over a window that fits its range: 6 hours for 24h,
// 1 day for 7d, and 7 days for 30d and 90d.
const ROLLING_WINDOW: Record<
  TimeRangeBucketUnit,
  { buckets: number; label: string }
> = {
  "6hour": { buckets: 4, label: "1-day" },
  day: { buckets: 7, label: "7-day" },
  hour: { buckets: 6, label: "6-hour" },
};

type CostTotals = Pick<Point, "mergedCodeChanges"> & {
  costUsd: number;
  mergedCodeChangeCostUsd: number;
};

function sumCosts(buckets: readonly ConversationMetricDay[]): CostTotals {
  return buckets.reduce(
    (total, bucket) => ({
      costUsd: total.costUsd + (bucket.costUsd ?? 0),
      mergedCodeChangeCostUsd:
        total.mergedCodeChangeCostUsd + (bucket.mergedCodeChangeCostUsd ?? 0),
      mergedCodeChanges:
        total.mergedCodeChanges + (bucket.mergedCodeChanges ?? 0),
    }),
    { costUsd: 0, mergedCodeChangeCostUsd: 0, mergedCodeChanges: 0 },
  );
}

function unitCosts(totals: CostTotals): Pick<Point, "allSpend" | "merged"> {
  if (!totals.mergedCodeChanges) return { allSpend: null, merged: null };
  return {
    allSpend: totals.costUsd / totals.mergedCodeChanges,
    merged: totals.mergedCodeChangeCostUsd / totals.mergedCodeChanges,
  };
}

/**
 * Mean cost over the window that ends on each of the last `points` buckets.
 * One bucket often has no merge, or one costly merge, so a ratio per bucket
 * is mostly noise. A bucket without a full window of history has no value, so
 * a line never starts on a partial window.
 */
function rollingCosts(
  history: readonly ConversationMetricDay[],
  points: number,
  windowBuckets: number,
): Point[] {
  const start = Math.max(0, history.length - points);
  return history.slice(start).map((bucket, offset) => {
    const end = start + offset + 1;
    const totals = sumCosts(
      end >= windowBuckets ? history.slice(end - windowBuckets, end) : [],
    );
    return { date: bucket.date, ...totals, ...unitCosts(totals) };
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

/**
 * Plot the rolling cost per merged code change at the bucket size of the
 * selected range, next to all model spend over the same merges. The gap is
 * spend that no merged change used. `history` holds the same buckets as
 * `days`, and may start earlier so the first points get a full window.
 */
export function MergedChangeCostChart(props: {
  bucketUnit: TimeRangeBucketUnit;
  days: ConversationMetricDay[];
  history: readonly ConversationMetricDay[];
}) {
  const window = ROLLING_WINDOW[props.bucketUnit];
  const data = rollingCosts(props.history, props.days.length, window.buckets);
  const period = sumCosts(props.days);
  const periodCosts = unitCosts(period);
  const maximum = Math.max(
    Number.EPSILON,
    ...data.flatMap((point) => [point.merged ?? 0, point.allSpend ?? 0]),
  );
  return (
    <Card>
      <ChartHeader
        description={`${formatCompactNumber(period.mergedCodeChanges)} merged changes. Lines are ${window.label} rolling means; the legend shows the period mean. All spend includes spend that merged nothing.`}
        title="Cost per merged change"
        trailing={
          <ChartLegend
            ariaLabel="Cost per merged change series"
            inline
            items={SERIES.map((series) => ({
              ...series,
              value: formatUnitCost(periodCosts[series.key]),
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
            aria-label={`${window.label} rolling cost per merged change per ${timeRangeBucketPerLabel(props.bucketUnit)}`}
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
                      `Per merged change (${formatCompactNumber(point.mergedCodeChanges)})`,
                      formatUnitCost(point.merged),
                    ],
                    ["All spend", formatUnitCost(point.allSpend)],
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
