import type { AutomationExecutionStatusDay } from "@sentry/junior/api/schema";
import { Bar, BarChart, CartesianGrid } from "recharts";
import {
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import {
  type TimeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";

const series = [
  { color: "var(--color-emerald-300)", key: "completed", label: "Completed" },
  { color: "var(--color-rose-300)", key: "failed", label: "Failed" },
  { color: "var(--color-amber-300)", key: "blocked", label: "Blocked" },
] as const;

const chartConfig = Object.fromEntries(
  series.map((item) => [item.key, { color: item.color, label: item.label }]),
);

/** Render one automation's terminal executions by status over a trailing window. */
export function AutomationExecutionStatusChart(props: {
  bucketUnit?: TimeRangeBucketUnit;

  days: AutomationExecutionStatusDay[];
  range: TimeRangeDays;
}) {
  const bucketUnit = props.bucketUnit ?? "day";

  const days = props.days;
  const totals = days.map((day) => day.completed + day.failed + day.blocked);
  const maximum = Math.max(1, ...totals);
  const hasExecutions = totals.some((total) => total > 0);

  return (
    <Card className="min-h-[15rem] p-4 sm:p-5">
      <div>
        <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
          Runs over time
        </h2>
        <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
          {bucketUnit === "hour"
            ? "Terminal runs for this automation each hour."
            : bucketUnit === "6hour"
              ? "Terminal runs for this automation each 6 hours."
              : "Terminal runs for this automation each day."}
        </p>
      </div>

      <ChartLegend
        ariaLabel="Automation execution status legend"
        items={series}
      />

      <div className="relative mt-3 overflow-hidden">
        <ChartContainer
          className="aspect-auto h-55 w-full"
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
                  rows={(day: AutomationExecutionStatusDay) => [
                    ["completed", day.completed],
                    ["failed", day.failed],
                    ["blocked", day.blocked],
                    ["total", day.completed + day.failed + day.blocked],
                  ]}
                />
              }
            />
            {series.map((item) => (
              <Bar
                dataKey={item.key}
                fill={`var(--color-${item.key})`}
                fillOpacity={0.82}
                isAnimationActive={false}
                key={item.key}
                maxBarSize={13}
                stackId="status"
              />
            ))}
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
