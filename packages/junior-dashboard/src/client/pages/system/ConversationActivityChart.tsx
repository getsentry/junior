import type { ConversationMetricDay } from "@sentry/junior/api/schema";

import {
  ActivityChartAverageLine,
  ActivityChartDateLabels,
  ActivityChartGrid,
  activityChartAverage,
  ActivityChartTooltip,
  ActivityTooltipRows,
  ChartSvg,
  createActivityChartLayout,
} from "../../components/charts/ActivityChart";
import { ChartHeader } from "../../components/charts/ChartHeader";
import { Card } from "../../components/layout/Card";
import {
  formatActivityChartAverage,
  formatCompactNumber,
} from "../../format";

/** Plot root conversations with recorded activity each day or hour. */
export function ConversationActivityChart(props: {
  bucketUnit?: "day" | "hour";
  days: ConversationMetricDay[];
}) {
  const bucketUnit = props.bucketUnit ?? "day";
  const layout = createActivityChartLayout(280);
  const maximum = Math.max(1, ...props.days.map((day) => day.conversations));
  const step = layout.plotWidth / Math.max(1, props.days.length);
  const barWidth = Math.max(2, Math.min(24, step * 0.68));
  const values = props.days.map((day) => day.conversations);
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = activityChartAverage(values);

  return (
    <Card>
      <ChartHeader
        description={`Root conversations with recorded activity, bucketed by ${bucketUnit}.`}
        title="Conversation activity"
        total={formatCompactNumber(total)}
      />
      <div className="px-2 py-3 sm:px-4 sm:py-4">
        <ChartSvg
          aria-label={`Conversations per ${bucketUnit}`}
          className="min-h-60 overflow-visible"
          layout={layout}
        >
          <ActivityChartGrid layout={layout} maximum={maximum} />
          {props.days.map((day, index) => {
            const x = layout.left + index * step + step / 2;
            const barHeight = (day.conversations / maximum) * layout.plotHeight;
            const renderedHeight = Math.max(
              day.conversations ? 2 : 0,
              barHeight,
            );
            return (
              <ActivityChartTooltip
                key={day.date}
                content={
                  <ActivityTooltipRows
                    rows={[["conversations", day.conversations]]}
                  />
                }
                date={day.date}
                summary={`${day.conversations} conversations`}
              >
                <g
                  tabIndex={0}
                >
                  <rect
                    fill="#22d3ee"
                    height={renderedHeight}
                    opacity={day.conversations ? 0.78 : 0.08}
                    rx="2"
                    width={barWidth}
                    x={x - barWidth / 2}
                    y={layout.top + layout.plotHeight - renderedHeight}
                  />
                  <rect
                    fill="transparent"
                    height={layout.plotHeight}
                    width={step}
                    x={layout.left + index * step}
                    y={layout.top}
                  />
                </g>
              </ActivityChartTooltip>
            );
          })}
          <ActivityChartAverageLine
            average={average}
            format={formatActivityChartAverage}
            layout={layout}
            maximum={maximum}
            stroke="#22d3ee"
            unit={bucketUnit}
          />
          <ActivityChartDateLabels
            dates={props.days.map((day) => day.date)}
            layout={layout}
            xPosition={(index) => layout.left + index * step + step / 2}
          />
        </ChartSvg>
      </div>
    </Card>
  );
}
