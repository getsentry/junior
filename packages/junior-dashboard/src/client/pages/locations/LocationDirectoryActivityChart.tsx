import type { LocationActivityDayReport } from "@sentry/junior/api/schema";

import {
  ActivityChartDateLabels,
  ActivityChartGrid,
  ActivityTooltipRows,
  ChartSvg,
  createActivityChartLayout,
  formatActivityTooltipDate,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";
import { Tooltip } from "../../components/Tooltip";

/** Compare public and privacy-preserving private conversation volume by day. */
export function LocationDirectoryActivityChart(props: {
  bucketUnit?: "day" | "hour";

  days: LocationActivityDayReport[];
}) {
  const bucketUnit = props.bucketUnit ?? "day";
  const perBucket =
    bucketUnit === "hour" ? "Conversations per hour" : "Conversations per day";

  const layout = createActivityChartLayout(260);
  const maximum = Math.max(
    1,
    ...props.days.flatMap((day) => [
      day.privateConversations,
      day.publicConversations,
    ]),
  );
  const step = layout.plotWidth / Math.max(1, props.days.length);
  const groupWidth = Math.max(3, Math.min(18, step * 0.8));
  const gap = Math.min(2, groupWidth * 0.15);
  const barWidth = Math.max(1.5, (groupWidth - gap) / 2);
  return (
    <Card>
      <CardHeader
        description={
          bucketUnit === "hour"
            ? "Hourly public volume compared with private activity in aggregate."
            : "Daily public volume compared with private activity in aggregate."
        }
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
      <div className="px-2 py-3 sm:px-4 sm:py-4">
        <ChartSvg
          aria-label={`Public and private ${perBucket.toLowerCase()}`}
          className="min-h-56 w-full overflow-visible"
          layout={layout}
        >
          <ActivityChartGrid layout={layout} maximum={maximum} />
          {props.days.flatMap((day, index) => {
            const groupX = layout.left + index * step + (step - groupWidth) / 2;
            return (
              [
                {
                  count: day.publicConversations,
                  fill: "#22d3ee",
                  key: "public",
                  x: groupX,
                },
                {
                  count: day.privateConversations,
                  fill: "#fbbf24",
                  key: "private",
                  x: groupX + barWidth + gap,
                },
              ] as const
            ).map((bar) => {
              const barHeight = (bar.count / maximum) * layout.plotHeight;
              return (
                <Tooltip
                  content={
                    <ActivityTooltipRows
                      rows={[
                        ["public", day.publicConversations],
                        ["private", day.privateConversations],
                      ]}
                    />
                  }
                  key={`${day.date}-${bar.key}`}
                  label={formatActivityTooltipDate(day.date)}
                >
                  <rect
                    aria-label={`${formatActivityTooltipDate(day.date)}: ${day.publicConversations} public conversations, ${day.privateConversations} private conversations`}
                    fill={bar.fill}
                    height={Math.max(bar.count ? 2 : 0, barHeight)}
                    opacity={bar.count ? 0.85 : 0.12}
                    rx="1.5"
                    tabIndex={0}
                    width={barWidth}
                    x={bar.x}
                    y={layout.top + layout.plotHeight - barHeight}
                  />
                </Tooltip>
              );
            });
          })}
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
