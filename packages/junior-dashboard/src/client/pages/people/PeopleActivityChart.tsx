import {
  type TimeRangeBucketUnit,
  timeRangeBucketAverageUnit,
  timeRangeBucketPerLabel,
} from "../../components/controls/TimeRangeSelector";
import type { PeopleActivityDayReport } from "@sentry/junior/api/schema";

import {
  activityChartAverage,
  chartAreaPath,
  chartLinePoints,
  chartPercent,
  ActivityTooltipRows,
  ChartBucket,
  ChartFrame,
  ChartPoint,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";
import { formatActivityChartAverage } from "../../format";

/** Plot distinct verified people with recorded conversation activity each day. */
export function PeopleActivityChart(props: {
  bucketUnit?: TimeRangeBucketUnit;

  days: PeopleActivityDayReport[];
}) {
  const bucketUnit = props.bucketUnit ?? "day";
  const chartTitle = `Active people per ${timeRangeBucketPerLabel(bucketUnit)}`;

  const values = props.days.map((day) => day.activePeople);
  const maximum = Math.max(1, ...values);
  const average = activityChartAverage(values);
  const dense = props.days.length > 30;
  return (
    <Card>
      <CardHeader
        description="Distinct verified actors grouped by recorded conversation activity."
        title={chartTitle}
        trailing={
          <ChartLegend
            ariaLabel="People activity legend"
            inline
            items={[{ color: "#fbbf24", key: "people", label: "people" }]}
          />
        }
      />
      <div className="px-4 py-4">
        <ChartFrame
          aria-label={chartTitle}
          average={{
            color: "#fbbf24",
            format: formatActivityChartAverage,
            unit: timeRangeBucketAverageUnit(bucketUnit),
            value: average,
          }}
          buckets={props.days.map((day) => day.date)}
          className="h-52"
          lines={
            values.length > 0 ? (
              <>
                <defs>
                  <linearGradient id="people-area" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id="people-line" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0%" stopColor="#f59e0b" />
                    <stop offset="55%" stopColor="#fbbf24" />
                    <stop offset="100%" stopColor="#22d3ee" />
                  </linearGradient>
                </defs>
                <path
                  d={chartAreaPath(values, maximum)}
                  fill="url(#people-area)"
                />
                <polyline
                  fill="none"
                  points={chartLinePoints(values, maximum)}
                  stroke="url(#people-line)"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.5"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            ) : null
          }
          maximum={maximum}
        >
          {props.days.map((day) => (
            <ChartBucket
              bucket={day.date}
              content={
                <ActivityTooltipRows
                  rows={[
                    ["active people", day.activePeople],
                    ["conversations", day.conversations],
                  ]}
                />
              }
              key={day.date}
              summary={`${day.activePeople} active people, ${day.conversations} conversations`}
            >
              <ChartPoint
                className={dense ? "size-1.5 opacity-35" : "size-2 opacity-75"}
                fill="#fbbf24"
                percent={chartPercent(day.activePeople, maximum)}
              />
            </ChartBucket>
          ))}
        </ChartFrame>
      </div>
    </Card>
  );
}
