import {
  type TimeRangeBucketUnit,
  timeRangeBucketAverageUnit,
  timeRangeBucketPerLabel,
} from "../../components/controls/TimeRangeSelector";
import type { PeopleActivityDayReport } from "@sentry/junior/api/schema";

import { Area, AreaChart, CartesianGrid } from "recharts";
import {
  ActivityChartAverageLine,
  activityChartAverage,
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";
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
            items={[
              {
                color: "var(--color-amber-400)",
                key: "people",
                label: "people",
              },
            ]}
          />
        }
      />
      <div className="px-2 py-3 sm:px-4 sm:py-4">
        <ChartContainer className="aspect-auto h-65 w-full" config={{}}>
          <AreaChart
            aria-label={chartTitle}
            data={props.days}
            margin={activityChartMargin}
            role="img"
          >
            <defs>
              <linearGradient id="people-area" x1="0" x2="0" y1="0" y2="1">
                <stop
                  offset="0%"
                  stopColor="var(--color-amber-500)"
                  stopOpacity="0.3"
                />
                <stop
                  offset="100%"
                  stopColor="var(--color-amber-500)"
                  stopOpacity="0"
                />
              </linearGradient>
              <linearGradient id="people-line" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="var(--color-amber-500)" />
                <stop offset="55%" stopColor="var(--color-amber-400)" />
                <stop offset="100%" stopColor="var(--color-cyan-400)" />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 5" vertical={false} />
            <ActivityChartYAxis maximum={maximum} />
            <ActivityChartXAxis keys={props.days.map((day) => day.date)} />
            <ChartTooltip
              content={
                <ActivityChartTooltipContent
                  rows={(day: PeopleActivityDayReport) => [
                    ["active people", day.activePeople],
                    ["conversations", day.conversations],
                  ]}
                />
              }
            />
            <Area
              activeDot={{ fill: "var(--color-amber-400)", r: 5 }}
              dataKey="activePeople"
              dot={{
                fill: "var(--color-amber-400)",
                fillOpacity: dense ? 0.35 : 0.75,
                r: dense ? 3 : 4,
                stroke: "none",
              }}
              fill="url(#people-area)"
              fillOpacity={1}
              isAnimationActive={false}
              stroke="url(#people-line)"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.5}
              type="linear"
            />
            <ActivityChartAverageLine
              unit={timeRangeBucketAverageUnit(bucketUnit)}
              average={average}
              format={formatActivityChartAverage}
              stroke="var(--color-amber-400)"
            />
          </AreaChart>
        </ChartContainer>
      </div>
    </Card>
  );
}
