import { Bar, BarChart, CartesianGrid } from "recharts";
import {
  type TimeRangeBucketUnit,
  timeRangeBucketAverageUnit,
} from "../../components/controls/TimeRangeSelector";
import type { ConversationMetricDay } from "@sentry/junior/api/schema";

import {
  ActivityChartAverageLine,
  activityChartAverage,
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "../../components/charts/ActivityChart";
import { ChartHeader } from "../../components/charts/ChartHeader";
import { Card } from "../../components/layout/Card";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";
import { formatActivityChartAverage, formatCompactNumber } from "../../format";

const chartConfig = {
  conversations: { color: "var(--color-cyan-400)", label: "Conversations" },
};

/** Plot root conversations with recorded activity each day or hour. */
export function ConversationActivityChart(props: {
  bucketUnit?: TimeRangeBucketUnit;
  days: ConversationMetricDay[];
}) {
  const bucketUnit = props.bucketUnit ?? "day";
  const maximum = Math.max(1, ...props.days.map((day) => day.conversations));
  const values = props.days.map((day) => day.conversations);
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = activityChartAverage(values);

  return (
    <Card>
      <ChartHeader
        description={`Root conversations with recorded activity, per ${bucketUnit === "6hour" ? "6 hours" : bucketUnit}.`}
        title="Conversation activity"
        total={formatCompactNumber(total)}
      />
      <div className="px-2 py-2">
        <ChartContainer
          className="aspect-auto h-38 w-full"
          config={chartConfig}
        >
          <BarChart
            aria-label={`Conversations per ${bucketUnit === "6hour" ? "6 hours" : bucketUnit}`}
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
                  rows={(day: ConversationMetricDay) => [
                    ["conversations", day.conversations],
                  ]}
                />
              }
            />
            <Bar
              dataKey="conversations"
              fill="var(--color-conversations)"
              fillOpacity={0.78}
              isAnimationActive={false}
              maxBarSize={24}
              minPointSize={(value) => (value ? 2 : 0)}
              radius={2}
            />
            <ActivityChartAverageLine
              average={average}
              format={formatActivityChartAverage}
              stroke="var(--color-cyan-400)"
              unit={timeRangeBucketAverageUnit(bucketUnit)}
            />
          </BarChart>
        </ChartContainer>
      </div>
    </Card>
  );
}
