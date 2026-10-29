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
import { formatCostSummary } from "../../format";

const chartConfig = {
  costUsd: { color: "var(--color-cyan-300)", label: "Spend" },
};

function formatSpend(value: number): string {
  return formatCostSummary({ total: value });
}

/** Render linked conversation spend for completed automation executions. */
export function AutomationCostChart(props: {
  bucketUnit?: TimeRangeBucketUnit;
  days: AutomationExecutionDay[];
  range: TimeRangeDays;
}) {
  const bucketUnit = props.bucketUnit ?? "day";
  const days = props.days;
  const totals = days.map((day) => day.costUsd);
  const total = totals.reduce((sum, value) => sum + value, 0);
  const maximum = Math.max(0.01, ...totals);
  const average = activityChartAverage(totals);
  const hasCost = totals.some((value) => value > 0);

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div>
        <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
          {formatCostSummary({ total }) || "$0.00"}
        </h2>
        <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
          Spend from conversations linked to completed automation executions.
        </p>
      </div>

      <div className="relative mt-5 overflow-hidden">
        <ChartContainer
          className="aspect-auto h-50 w-full"
          config={chartConfig}
        >
          <BarChart
            aria-label={`Automation execution spend during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
            data={days}
            margin={activityChartMargin}
            role="img"
          >
            <CartesianGrid strokeDasharray="3 5" vertical={false} />
            <ActivityChartYAxis format={formatSpend} maximum={maximum} />
            <ActivityChartXAxis keys={days.map((day) => day.date)} />
            <ChartTooltip
              content={
                <ActivityChartTooltipContent
                  rows={(day: AutomationExecutionDay) => [
                    ["spend", formatSpend(day.costUsd)],
                  ]}
                />
              }
            />
            <Bar
              dataKey="costUsd"
              fill="var(--color-costUsd)"
              fillOpacity={0.82}
              isAnimationActive={false}
              maxBarSize={13}
              radius={1}
            />
            <ActivityChartAverageLine
              unit={timeRangeBucketAverageUnit(bucketUnit)}
              average={average}
              format={formatSpend}
              stroke="var(--color-slate-200)"
            />
          </BarChart>
        </ChartContainer>
        {!hasCost ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-sans text-xs text-dashboard-text-muted">
            No linked spend in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
