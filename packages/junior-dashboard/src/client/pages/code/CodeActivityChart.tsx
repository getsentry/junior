import {
  type TimeRangeBucketUnit,
  timeRangeBucketAverageUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import type { CodeActivityDay } from "@sentry/junior/api/schema";
import { Bar, BarChart, CartesianGrid } from "recharts";
import {
  ActivityChartAverageLine,
  activityChartAverage,
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";

import { Card } from "../../components/layout/Card";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";
import { formatActivityChartAverage } from "../../format";

const CREATED_COLOR = "var(--color-cyan-300)";
const MERGED_COLOR = "var(--color-emerald-300)";
const CLOSED_COLOR = "var(--color-rose-400)";
const series = [
  { color: CREATED_COLOR, key: "created", label: "Created" },
  { color: MERGED_COLOR, key: "merged", label: "Merged" },
  { color: CLOSED_COLOR, key: "closed", label: "Closed" },
] as const;
const chartConfig = Object.fromEntries(
  series.map((item) => [item.key, { color: item.color, label: item.label }]),
);

/** Render created, merged, and closed code changes over a trailing window. */
export function CodeActivityChart(props: {
  bucketUnit?: TimeRangeBucketUnit;

  days: CodeActivityDay[];
  range: TimeRangeDays;
}) {
  const bucketUnit = props.bucketUnit ?? "day";

  const days = props.days;
  const totals = days.map((day) => day.created + day.merged + day.closed);
  const maximum = Math.max(
    1,
    ...days.flatMap((day) => [day.created, day.merged, day.closed]),
  );
  const average = activityChartAverage(days.map((day) => day.created));
  const hasActivity = totals.some((total) => total > 0);

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
            Changes over time
          </h2>
          <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
            Code changes created, merged, and closed each day.
          </p>
        </div>
        <ChartLegend ariaLabel="Code change legend" items={series} />
      </div>

      <div className="relative mt-5 overflow-hidden">
        <ChartContainer
          className="aspect-auto h-55 w-full"
          config={chartConfig}
        >
          <BarChart
            aria-label={`Code changes during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
            barGap={1}
            data={days}
            margin={activityChartMargin}
            role="img"
          >
            <CartesianGrid strokeDasharray="3 5" vertical={false} />
            <ActivityChartYAxis maximum={maximum} />
            <ActivityChartXAxis keys={days.map((day) => day.date)} />
            <ChartTooltip
              content={
                <ActivityChartTooltipContent
                  rows={(day: CodeActivityDay) =>
                    series.map((item) => [
                      item.label.toLowerCase(),
                      day[item.key],
                    ])
                  }
                />
              }
            />
            {series.map((item) => (
              <Bar
                dataKey={item.key}
                fill={`var(--color-${item.key})`}
                fillOpacity={0.86}
                isAnimationActive={false}
                key={item.key}
                maxBarSize={10}
                radius={1}
              />
            ))}
            <ActivityChartAverageLine
              unit={timeRangeBucketAverageUnit(bucketUnit)}
              average={average}
              format={formatActivityChartAverage}
              stroke="var(--color-slate-200)"
            />
          </BarChart>
        </ChartContainer>
        {!hasActivity ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-sans text-xs text-dashboard-text-muted">
            No code changes in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
