import {
  type TimeRangeBucketUnit,
  timeRangeBucketAverageUnit,
} from "../../components/controls/TimeRangeSelector";
import type { ConversationMetricDay } from "@sentry/junior/api/schema";

import {
  activityChartAverage,
  ActivityTooltipRows,
  ChartBar,
  ChartBucket,
  ChartFrame,
  chartPercent,
} from "../../components/charts/ActivityChart";
import { ChartHeader } from "../../components/charts/ChartHeader";
import { Card } from "../../components/layout/Card";
import { formatActivityChartAverage, formatCompactNumber } from "../../format";

/** Plot root conversations with recorded activity each day or hour. */
export function ConversationActivityChart(props: {
  bucketUnit?: TimeRangeBucketUnit;
  days: ConversationMetricDay[];
}) {
  const bucketUnit = props.bucketUnit ?? "day";
  const values = props.days.map((day) => day.conversations);
  const maximum = Math.max(1, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = activityChartAverage(values);

  return (
    <Card>
      <ChartHeader
        description={`Root conversations with recorded activity, per ${bucketUnit === "6hour" ? "6 hours" : bucketUnit}.`}
        title="Conversation activity"
        total={formatCompactNumber(total)}
      />
      <div className="px-4 pt-4 pb-3">
        <ChartFrame
          aria-label={`Conversations per ${bucketUnit === "6hour" ? "6 hours" : bucketUnit}`}
          average={{
            color: "#22d3ee",
            format: formatActivityChartAverage,
            unit: timeRangeBucketAverageUnit(bucketUnit),
            value: average,
          }}
          buckets={props.days.map((day) => day.date)}
          className="h-26"
          maximum={maximum}
        >
          {props.days.map((day) => (
            <ChartBucket
              bucket={day.date}
              content={
                <ActivityTooltipRows
                  rows={[["conversations", day.conversations]]}
                />
              }
              key={day.date}
              summary={`${day.conversations} conversations`}
            >
              <ChartBar
                className="w-[68%] max-w-6 rounded-t-xs opacity-78"
                fill="#22d3ee"
                percent={chartPercent(day.conversations, maximum)}
              />
            </ChartBucket>
          ))}
        </ChartFrame>
      </div>
    </Card>
  );
}
