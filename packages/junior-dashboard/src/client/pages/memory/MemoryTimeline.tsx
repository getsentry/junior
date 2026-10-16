import {
  ActivityTooltipRows,
  ChartBar,
  ChartBucket,
  ChartFrame,
  chartPercent,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import {
  type TimeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import type { MemoryDay } from "./memoryDashboard";

const series = [
  { color: "#67e8f9", key: "personal", label: "Personal" },
  { color: "#6ee7b7", key: "public", label: "Public" },
] as const;

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

      <div className="mt-3">
        <ChartFrame
          aria-label={`Memories learned during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
          buckets={days.map((day) => day.date)}
          empty={
            hasMemories ? undefined : "No memories were learned in this period."
          }
          maximum={maximum}
        >
          {days.map((day, dayIndex) => {
            const total = totals[dayIndex] ?? 0;
            return (
              <ChartBucket
                bucket={day.date}
                content={
                  <ActivityTooltipRows
                    rows={[
                      ["personal", day.personal],
                      ["public", day.public],
                      ["total", total],
                    ]}
                  />
                }
                key={day.date}
                summary={`${day.personal} personal, ${day.public} public, ${total} total memories`}
              >
                <span className="flex h-full w-[68%] max-w-3.25 flex-col-reverse">
                  {series.map((item) => (
                    <ChartBar
                      className="w-full opacity-82"
                      fill={item.color}
                      key={item.key}
                      percent={chartPercent(day[item.key], maximum)}
                    />
                  ))}
                </span>
              </ChartBucket>
            );
          })}
        </ChartFrame>
      </div>
    </Card>
  );
}
