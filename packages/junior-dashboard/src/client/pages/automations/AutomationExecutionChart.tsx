import {
  type TimeRangeBucketUnit,
  timeRangeBucketAverageUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import type { AutomationExecutionDay } from "@sentry/junior/api/schema";
import {
  activityChartAverage,
  ActivityTooltipRows,
  ChartBar,
  ChartBucket,
  ChartFrame,
  chartPercent,
} from "../../components/charts/ActivityChart";

import { Card } from "../../components/layout/Card";
import { formatActivityChartAverage } from "../../format";

const EXECUTION_COLOR = "#fbbf24";

/** Render completed automation executions over a trailing window. */
export function AutomationExecutionChart(props: {
  bucketUnit?: TimeRangeBucketUnit;

  days: AutomationExecutionDay[];
  range: TimeRangeDays;
}) {
  const bucketUnit = props.bucketUnit ?? "day";

  const days = props.days;
  const totals = days.map((day) => day.scheduled + day.event);
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

      <div className="mt-5">
        <ChartFrame
          aria-label={`Automation executions during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
          average={{
            color: "#e2e8f0",
            format: formatActivityChartAverage,
            unit: timeRangeBucketAverageUnit(bucketUnit),
            value: average,
          }}
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
                content={<ActivityTooltipRows rows={[["executions", total]]} />}
                key={day.date}
                summary={`${total} executions`}
              >
                <ChartBar
                  className="w-[68%] max-w-3.25 opacity-82"
                  fill={EXECUTION_COLOR}
                  percent={chartPercent(total, maximum)}
                />
              </ChartBucket>
            );
          })}
        </ChartFrame>
      </div>
    </Card>
  );
}
