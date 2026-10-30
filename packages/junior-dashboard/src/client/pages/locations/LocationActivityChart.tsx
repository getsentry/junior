import {
  type TimeRangeBucketUnit,
  timeRangeBucketAverageUnit,
} from "../../components/controls/TimeRangeSelector";
import type { DailyConversationActivity } from "@sentry/junior/api/schema";

import { Bar, BarChart, CartesianGrid } from "recharts";
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
            items={[
              {
                color: "var(--color-cyan-400)",
                key: "period",
                label: "90 days",
              },
            ]}
          />
        }
      />
      <div className="px-2 py-3 sm:px-4 sm:py-4">
        <ChartContainer className="aspect-auto h-60 w-full" config={{}}>
          <BarChart
            aria-label="Daily conversations for this location"
            data={props.days}
            margin={activityChartMargin}
            role="img"
          >
            <defs>
              <linearGradient id="location-bars" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--color-cyan-400)" />
                <stop
                  offset="100%"
                  stopColor="var(--color-amber-500)"
                  stopOpacity="0.65"
                />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 5" vertical={false} />
            <ActivityChartYAxis maximum={maximum} />
            <ActivityChartXAxis keys={props.days.map((day) => day.date)} />
            <ChartTooltip
              content={
                <ActivityChartTooltipContent
                  rows={(day: DailyConversationActivity) => [
                    ["conversations", day.conversations],
                    ["active", day.active],
                    ["failed", day.failed],
                  ]}
                />
              }
            />
            <Bar
              dataKey="conversations"
              fill="url(#location-bars)"
              fillOpacity={0.9}
              isAnimationActive={false}
              maxBarSize={20}
              minPointSize={(value) => (value ? 2 : 0)}
              radius={2}
            />
            <ActivityChartAverageLine
              unit={timeRangeBucketAverageUnit(bucketUnit)}
              average={average}
              format={formatActivityChartAverage}
              stroke="var(--color-cyan-400)"
            />
          </BarChart>
        </ChartContainer>
      </div>
    </Card>
  );
}
