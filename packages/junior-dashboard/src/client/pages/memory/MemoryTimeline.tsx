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
import type { MemoryDay } from "./memoryDashboard";

const series = [
  { color: "var(--color-cyan-300)", key: "personal", label: "Personal" },
  { color: "var(--color-emerald-300)", key: "public", label: "Public" },
] as const;

const chartConfig = Object.fromEntries(
  series.map((item) => [item.key, { color: item.color, label: item.label }]),
);

/** Render viewer memory creation as a stacked personal/public timeline. */
export function MemoryTimeline(props: {
  bucketUnit?: TimeRangeBucketUnit;

  days: MemoryDay[];
  range: TimeRangeDays;
}) {
  const bucketUnit = props.bucketUnit ?? "day";

  const days = props.days;
  const totals = days.map((day) => day.personal + day.public);
  const maximum = Math.max(1, ...totals);
  const hasMemories = totals.some((total) => total > 0);

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div>
        <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
          Activity over time
        </h2>
        <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
          {bucketUnit === "hour"
            ? "Stacked personal + public memories created each hour."
            : bucketUnit === "6hour"
              ? "Stacked personal + public memories created each 6 hours."
              : "Stacked personal + public memories created each day."}
        </p>
      </div>

      <ChartLegend ariaLabel="Memory visibility legend" items={series} />

      <div className="relative mt-3 overflow-hidden">
        <ChartContainer
          className="aspect-auto h-50 w-full"
          config={chartConfig}
        >
          <BarChart
            aria-label={`Memories learned during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
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
                  rows={(day: MemoryDay) => [
                    ["personal", day.personal],
                    ["public", day.public],
                    ["total", day.personal + day.public],
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
                stackId="visibility"
              />
            ))}
          </BarChart>
        </ChartContainer>
        {!hasMemories ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-sans text-xs text-dashboard-text-muted">
            No memories were learned in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
