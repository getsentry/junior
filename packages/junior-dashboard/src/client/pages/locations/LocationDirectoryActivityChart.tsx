import {
  type TimeRangeBucketUnit,
  timeRangeBucketAdjective,
  timeRangeBucketPerLabel,
} from "../../components/controls/TimeRangeSelector";
import type { LocationActivityDayReport } from "@sentry/junior/api/schema";

import {
  ActivityTooltipRows,
  ChartBar,
  ChartBucket,
  ChartFrame,
  chartPercent,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";

/** Compare public and privacy-preserving private conversation volume by day. */
export function LocationDirectoryActivityChart(props: {
  bucketUnit?: TimeRangeBucketUnit;

  days: LocationActivityDayReport[];
}) {
  const bucketUnit = props.bucketUnit ?? "day";
  const perBucket = `Conversations per ${timeRangeBucketPerLabel(bucketUnit)}`;

  const maximum = Math.max(
    1,
    ...props.days.flatMap((day) => [
      day.privateConversations,
      day.publicConversations,
    ]),
  );
  return (
    <Card>
      <CardHeader
        description={`${timeRangeBucketAdjective(bucketUnit)} public volume compared with private activity in aggregate.`}
        title={perBucket}
        trailing={
          <ChartLegend
            ariaLabel="Conversation visibility legend"
            inline
            items={[
              { color: "#22d3ee", key: "public", label: "public" },
              { color: "#fbbf24", key: "private", label: "private" },
            ]}
          />
        }
      />
      <div className="px-4 py-4">
        <ChartFrame
          aria-label={`Public and private ${perBucket.toLowerCase()}`}
          buckets={props.days.map((day) => day.date)}
          className="h-52"
          maximum={maximum}
        >
          {props.days.map((day) => (
            <ChartBucket
              bucket={day.date}
              content={
                <ActivityTooltipRows
                  rows={[
                    ["public", day.publicConversations],
                    ["private", day.privateConversations],
                  ]}
                />
              }
              key={day.date}
              summary={`${day.publicConversations} public conversations, ${day.privateConversations} private conversations`}
            >
              <span className="flex h-full w-[80%] max-w-4.5 items-end gap-0.5">
                {[
                  { count: day.publicConversations, fill: "#22d3ee" },
                  { count: day.privateConversations, fill: "#fbbf24" },
                ].map((bar) => (
                  <span
                    className="flex h-full min-w-0 flex-1 items-end"
                    key={bar.fill}
                  >
                    <ChartBar
                      className="w-full opacity-85"
                      fill={bar.fill}
                      percent={chartPercent(bar.count, maximum)}
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
