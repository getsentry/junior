import {
  type TimeRangeBucketUnit,
  timeRangeBucketAverageUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import type { CodeActivityDay } from "@sentry/junior/api/schema";
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
import { formatActivityChartAverage } from "../../format";

const CREATED_COLOR = "#67e8f9";
const MERGED_COLOR = "#6ee7b7";
const CLOSED_COLOR = "#fb7185";

/** Render created, merged, and closed code changes over a trailing window. */
export function CodeActivityChart(props: {
  bucketUnit?: TimeRangeBucketUnit;

  days: CodeActivityDay[];
  range: TimeRangeDays;
}) {
  const bucketUnit = props.bucketUnit ?? "day";

  const days = props.days;
  const maximum = Math.max(
    1,
    ...days.flatMap((day) => [day.created, day.merged, day.closed]),
  );
  const average = activityChartAverage(days.map((day) => day.created));
  const hasActivity = days.some(
    (day) => day.created + day.merged + day.closed > 0,
  );

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
            Changes over time
          </h2>
          <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
            Code changes created, merged, and closed each day.
          </p>
        </div>
        <ChartLegend
          ariaLabel="Code change legend"
          items={[
            { color: CREATED_COLOR, key: "created", label: "Created" },
            { color: MERGED_COLOR, key: "merged", label: "Merged" },
            { color: CLOSED_COLOR, key: "closed", label: "Closed" },
          ]}
        />
      </div>

      <div className="mt-5">
        <ChartFrame
          aria-label={`Code changes during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
          average={{
            color: "#e2e8f0",
            format: formatActivityChartAverage,
            unit: timeRangeBucketAverageUnit(bucketUnit),
            value: average,
          }}
          buckets={days.map((day) => day.date)}
          empty={hasActivity ? undefined : "No code changes in this period."}
          maximum={maximum}
        >
          {days.map((day) => (
            <ChartBucket
              bucket={day.date}
              content={
                <ActivityTooltipRows
                  rows={[
                    ["created", day.created],
                    ["merged", day.merged],
                    ["closed", day.closed],
                  ]}
                />
              }
              key={day.date}
              summary={`${day.created} created, ${day.merged} merged, ${day.closed} closed`}
            >
              <span className="flex h-full w-[88%] max-w-8.5 items-end gap-px">
                {[
                  { color: CREATED_COLOR, value: day.created },
                  { color: MERGED_COLOR, value: day.merged },
                  { color: CLOSED_COLOR, value: day.closed },
                ].map((entry) => (
                  <span
                    className="flex h-full min-w-0 flex-1 items-end"
                    key={entry.color}
                  >
                    <ChartBar
                      className="w-full opacity-85"
                      fill={entry.color}
                      percent={chartPercent(entry.value, maximum)}
                    />
                  </span>
                ))}
              </span>
            </ChartBucket>
          ))}
        </ChartFrame>
      </div>
    </Card>
  );
}
