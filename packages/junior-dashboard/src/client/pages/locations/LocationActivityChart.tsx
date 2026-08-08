import type { DailyConversationActivity } from "@sentry/junior/api/schema";

import {
  ActivityChartAverageLine,
  ActivityChartDateLabels,
  ActivityChartGrid,
  activityChartAverage,
  ActivityTooltipRows,
  ChartSvg,
  createActivityChartLayout,
  formatActivityDate,
} from "../../components/charts/ActivityChart";
import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";
import { Tooltip } from "../../components/Tooltip";
import { formatActivityChartAverage } from "../../format";

/** Plot daily conversation volume across one public location. */
export function LocationActivityChart(props: {
  days: DailyConversationActivity[];
}) {
  const layout = createActivityChartLayout(240);
  const values = props.days.map((day) => day.conversations);
  const maximum = Math.max(1, ...values);
  const average = activityChartAverage(values);
  const step = layout.plotWidth / Math.max(1, props.days.length);
  const barWidth = Math.max(4, Math.min(20, step * 0.55));

  return (
    <Card>
      <CardHeader
        description="Daily persisted conversations for this location."
        title="Conversation activity"
        trailing={
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.5)]" />
            90 days
          </span>
        }
      />
      <div className="px-2 py-3 sm:px-4 sm:py-4">
        <ChartSvg
          aria-label="Daily conversations for this location"
          className="min-h-52 w-full overflow-visible"
          layout={layout}
        >
          <defs>
            <linearGradient id="location-bars" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#22d3ee" />
              <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.65" />
            </linearGradient>
          </defs>
          <ActivityChartGrid layout={layout} maximum={maximum} />
          {props.days.map((day, index) => {
            const barHeight = (day.conversations / maximum) * layout.plotHeight;
            const x = layout.left + index * step + (step - barWidth) / 2;
            const y = layout.top + layout.plotHeight - barHeight;
            return (
              <Tooltip
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
                label={formatActivityDate(day.date)}
              >
                <rect
                  aria-label={`${formatActivityDate(day.date)}: ${day.conversations} conversations, ${day.active} active, ${day.failed} failed`}
                  fill="url(#location-bars)"
                  height={Math.max(day.conversations ? 2 : 0, barHeight)}
                  opacity={day.conversations ? 0.9 : 0.18}
                  rx="2"
                  tabIndex={0}
                  width={barWidth}
                  x={x}
                  y={y}
                />
              </Tooltip>
            );
          })}
          <ActivityChartAverageLine
            average={average}
            format={formatActivityChartAverage}
            layout={layout}
            maximum={maximum}
            stroke="#22d3ee"
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
