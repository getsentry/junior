import { Bar, BarChart, CartesianGrid } from "recharts";
import {
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "../../components/charts/ActivityChart";
import {
  type TimeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { AnchorHeading } from "../../components/layout/AnchorHeading";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";
import type { MemoryDay } from "./memoryDashboard";

const chartConfig = {
  count: { color: "var(--color-emerald-300)", label: "Memories" },
};

/** Render memory creation as a timeline. */
export function MemoryTimeline(props: {
  bucketUnit?: TimeRangeBucketUnit;

  days: MemoryDay[];
  range: TimeRangeDays;
}) {
  const bucketUnit = props.bucketUnit ?? "day";

  const days = props.days;
  const totals = days.map((day) => day.count);
  const maximum = Math.max(1, ...totals);
  const hasMemories = totals.some((total) => total > 0);

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div>
        <AnchorHeading
          anchor="activity"
          className="m-0 font-display text-xl font-medium text-dashboard-text"
          title="Activity over time"
        />
        <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
          {bucketUnit === "hour"
            ? "Memories created each hour."
            : bucketUnit === "6hour"
              ? "Memories created each 6 hours."
              : "Memories created each day."}
        </p>
      </div>

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
                  rows={(day: MemoryDay) => [["memories", day.count]]}
                />
              }
            />
            <Bar
              dataKey="count"
              fill="var(--color-count)"
              fillOpacity={0.82}
              isAnimationActive={false}
              maxBarSize={13}
            />
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
