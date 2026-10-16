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
import { formatCostSummary } from "../../format";

const COST_COLOR = "#67e8f9";

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
  const formatCost = (value: number) => formatCostSummary({ total: value });

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

      <div className="mt-5">
        <ChartFrame
          aria-label={`Automation execution spend during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
          average={{
            color: "#e2e8f0",
            format: formatCost,
            unit: timeRangeBucketAverageUnit(bucketUnit),
            value: average,
          }}
          buckets={days.map((day) => day.date)}
          empty={hasCost ? undefined : "No linked spend in this period."}
          formatTick={formatCost}
          maximum={maximum}
        >
          {days.map((day, dayIndex) => {
            const value = totals[dayIndex] ?? 0;
            return (
              <ChartBucket
                bucket={day.date}
                content={
                  <ActivityTooltipRows rows={[["spend", formatCost(value)]]} />
                }
                key={day.date}
                summary={formatCost(value)}
              >
                <ChartBar
                  className="w-[68%] max-w-3.25 opacity-82"
                  fill={COST_COLOR}
                  percent={chartPercent(value, maximum)}
                />
              </ChartBucket>
            );
          })}
        </ChartFrame>
      </div>
    </Card>
  );
}
