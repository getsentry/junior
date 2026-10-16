import {
  type TimeRangeBucketUnit,
  timeRangeBucketAverageUnit,
} from "../../components/controls/TimeRangeSelector";
import type { DailyConversationActivity } from "@sentry/junior/api/schema";

import {
  activityChartAverage,
  ActivityTooltipRows,
  ChartBar,
  ChartBucket,
  ChartFrame,
  chartPercent,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";
import { formatActivityChartAverage } from "../../format";

/** Plot daily conversation volume across one public location. */
export function LocationActivityChart(props: {
  bucketUnit?: TimeRangeBucketUnit;

  days: DailyConversationActivity[];
}) {
  const bucketUnit = props.bucketUnit ?? "day";

  const values = props.days.map((day) => day.conversations);
  const maximum = Math.max(1, ...values);
  const average = activityChartAverage(values);

  return (
    <Card>
      <CardHeader
        description="Daily persisted conversations for this location."
        title="Conversation activity"
        trailing={
          <ChartLegend
            ariaLabel="Conversation activity period"
            inline
            items={[{ color: "#22d3ee", key: "period", label: "90 days" }]}
          />
        }
      />
      <div className="px-4 py-4">
        <ChartFrame
          aria-label="Daily conversations for this location"
          average={{
            color: "#22d3ee",
            format: formatActivityChartAverage,
            unit: timeRangeBucketAverageUnit(bucketUnit),
            value: average,
          }}
          buckets={props.days.map((day) => day.date)}
          className="h-48"
          maximum={maximum}
        >
          {props.days.map((day) => (
            <ChartBucket
              bucket={day.date}
              content={
                <ActivityTooltipRows
                  rows={[
                    ["conversations", day.conversations],
                    ["active", day.active],
                    ["failed", day.failed],
                  ]}
                />
              }
              key={day.date}
              summary={`${day.conversations} conversations, ${day.active} active, ${day.failed} failed`}
            >
              <ChartBar
                className="w-[55%] max-w-5 rounded-t-xs opacity-90"
                fill="linear-gradient(to bottom, #22d3ee, rgb(245 158 11 / 0.65))"
                percent={chartPercent(day.conversations, maximum)}
              />
            </ChartBucket>
          ))}
        </ChartFrame>
      </div>
    </Card>
  );
}
