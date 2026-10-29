import {
  type TimeRangeBucketUnit,
  timeRangeBucketAverageUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import type { AutomationExecutionDay } from "@sentry/junior/api/schema";
import { Bar, BarChart, CartesianGrid } from "recharts";
import {
  ActivityChartAverageLine,
  activityChartAverage,
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "../../components/charts/ActivityChart";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";

import { Card } from "../../components/layout/Card";
import { formatActivityChartAverage } from "../../format";

const chartConfig = {
  total: { color: "var(--color-amber-400)", label: "Executions" },
};

/** Render completed automation executions over a trailing window. */
export function AutomationExecutionChart(props: {
  bucketUnit?: TimeRangeBucketUnit;

  days: AutomationExecutionDay[];
  range: TimeRangeDays;
}) {
  const bucketUnit = props.bucketUnit ?? "day";

  const days = props.days.map((day) => ({
    date: day.date,
    total: day.scheduled + day.event,
  }));
  const totals = days.map((day) => day.total);
  const maximum = Math.max(1, ...totals);
  const average = activityChartAverage(totals);
  const hasExecutions = totals.some((total) => total > 0);

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div>
        <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
          {totals.reduce((sum, value) => sum + value, 0).toLocaleString()} runs
        </h2>
        <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
          Completed automation executions over time.
        </p>
      </div>

      <div className="relative mt-5 overflow-hidden">
        <ChartContainer
          className="aspect-auto h-50 w-full"
          config={chartConfig}
        >
          <BarChart
            aria-label={`Automation executions during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
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
                  rows={(day: (typeof days)[number]) => [
                    ["executions", day.total],
                  ]}
                />
              }
            />
            <Bar
              dataKey="total"
              fill="var(--color-total)"
              fillOpacity={0.82}
              isAnimationActive={false}
              maxBarSize={13}
              radius={1}
            />
            <ActivityChartAverageLine
              unit={timeRangeBucketAverageUnit(bucketUnit)}
              average={average}
              format={formatActivityChartAverage}
              stroke="var(--color-slate-200)"
            />
          </BarChart>
        </ChartContainer>
        {!hasExecutions ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-sans text-xs text-dashboard-text-muted">
            No automation executions in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
