import {
  type TimeRangeBucketUnit,
  timeRangeBucketAdjective,
  timeRangeBucketPerLabel,
} from "../../components/controls/TimeRangeSelector";
import type { LocationActivityDayReport } from "@sentry/junior/api/schema";

import { Bar, BarChart, CartesianGrid } from "recharts";
import {
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";

const series = [
  {
    color: "var(--color-cyan-400)",
    dataKey: "publicConversations",
    key: "public",
    label: "public",
  },
  {
    color: "var(--color-amber-400)",
    dataKey: "privateConversations",
    key: "private",
    label: "private",
  },
] as const;
const chartConfig = Object.fromEntries(
  series.map((item) => [item.key, { color: item.color, label: item.label }]),
);

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
            items={series}
          />
        }
      />
      <div className="px-2 py-3 sm:px-4 sm:py-4">
        <ChartContainer
          className="aspect-auto h-65 w-full"
          config={chartConfig}
        >
          <BarChart
            aria-label={`Public and private ${perBucket.toLowerCase()}`}
            barGap={2}
            data={props.days}
            margin={activityChartMargin}
            role="img"
          >
            <CartesianGrid strokeDasharray="3 5" vertical={false} />
            <ActivityChartYAxis maximum={maximum} />
            <ActivityChartXAxis keys={props.days.map((day) => day.date)} />
            <ChartTooltip
              content={
                <ActivityChartTooltipContent
                  rows={(day: LocationActivityDayReport) =>
                    series.map((item) => [item.label, day[item.dataKey]])
                  }
                />
              }
            />
            {series.map((item) => (
              <Bar
                dataKey={item.dataKey}
                fill={`var(--color-${item.key})`}
                fillOpacity={0.85}
                isAnimationActive={false}
                key={item.key}
                maxBarSize={8}
                minPointSize={(value) => (value ? 2 : 0)}
                radius={1.5}
              />
            ))}
          </BarChart>
        </ChartContainer>
      </div>
    </Card>
  );
}
