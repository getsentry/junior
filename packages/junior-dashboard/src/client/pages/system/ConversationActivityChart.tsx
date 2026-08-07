import type { ConversationMetricDay } from "@sentry/junior/api/schema";

import {
  ActivityChartDateLabels,
  ActivityChartGrid,
  ActivityTooltipRows,
  createActivityChartLayout,
  formatActivityDate,
} from "../../components/charts/ActivityChart";
import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";
import { formatCompactNumber } from "../../format";

/** Plot root conversations with recorded activity each day. */
export function ConversationActivityChart(props: {
  days: ConversationMetricDay[];
}) {
  const layout = createActivityChartLayout(280);
  const maximum = Math.max(1, ...props.days.map((day) => day.conversations));
  const step = layout.plotWidth / Math.max(1, props.days.length);
  const barWidth = Math.max(2, Math.min(24, step * 0.68));
  const total = props.days.reduce((sum, day) => sum + day.conversations, 0);

  return (
    <Card>
      <div className="border-b border-white/[0.06] px-4 py-4 sm:px-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="m-0 font-mono text-xs font-medium uppercase tracking-[0.14em] text-dashboard-text-muted">
              Conversation activity
            </h3>
            <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
              Root conversations with recorded activity, bucketed by day.
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-display text-xl font-light text-dashboard-text">
              {formatCompactNumber(total)}
            </div>
            <div className="font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
              period total
            </div>
          </div>
        </div>
      </div>
      <div className="px-2 py-3 sm:px-4 sm:py-4">
        <svg
          aria-label="Conversations per day"
          className="block h-auto min-h-60 w-full overflow-visible"
          role="img"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
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
              <Tooltip
                content={
                  <ActivityTooltipRows
                    rows={[["conversations", day.conversations]]}
                  />
                }
                key={day.date}
                label={formatActivityDate(day.date)}
              >
                <g
                  aria-label={`${formatActivityDate(day.date)}: ${day.conversations} conversations`}
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
              </Tooltip>
            );
          })}
          <ActivityChartDateLabels
            dates={props.days.map((day) => day.date)}
            layout={layout}
            xPosition={(index) => layout.left + index * step + step / 2}
          />
        </svg>
      </div>
    </Card>
  );
}
