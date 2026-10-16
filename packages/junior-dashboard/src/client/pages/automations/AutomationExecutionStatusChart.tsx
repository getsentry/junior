import type { AutomationExecutionStatusDay } from "@sentry/junior/api/schema";
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

const series = [
  { color: "#6ee7b7", key: "completed", label: "Completed" },
  { color: "#fda4af", key: "failed", label: "Failed" },
  { color: "#fcd34d", key: "blocked", label: "Blocked" },
] as const;

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
          Executions over time
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

      <div className="mt-3">
        <ChartFrame
          aria-label={`Automation executions during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
          buckets={days.map((day) => day.date)}
          empty={
            hasExecutions
              ? undefined
              : "No automation executions in this period."
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
                      ["completed", day.completed],
                      ["failed", day.failed],
                      ["blocked", day.blocked],
                      ["total", total],
                    ]}
                  />
                }
                key={day.date}
                summary={`${day.completed} completed, ${day.failed} failed, ${day.blocked} blocked, ${total} total`}
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
