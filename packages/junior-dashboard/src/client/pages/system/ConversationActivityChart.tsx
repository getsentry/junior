import type { ConversationMetricDay } from "@sentry/junior/api/schema";

import {
  ActivityChartDateLabels,
  ActivityChartGrid,
  ActivityTooltipRows,
  createActivityChartLayout,
  formatActivityDate,
  type ActivityChartLayout,
} from "../../components/charts/ActivityChart";
import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";
import { formatCompactNumber } from "../../format";

function chartPoint(
  day: ConversationMetricDay,
  index: number,
  count: number,
  maximum: number,
  layout: ActivityChartLayout,
) {
  return {
    x: layout.left + (index / Math.max(1, count - 1)) * layout.plotWidth,
    y:
      layout.top +
      layout.plotHeight -
      (day.conversations / maximum) * layout.plotHeight,
  };
}

/** Plot root conversations with recorded activity each day. */
export function ConversationActivityChart(props: {
  days: ConversationMetricDay[];
}) {
  const layout = createActivityChartLayout(280);
  const maximum = Math.max(1, ...props.days.map((day) => day.conversations));
  const points = props.days.map((day, index) =>
    chartPoint(day, index, props.days.length, maximum, layout),
  );
  const baseline = layout.top + layout.plotHeight;
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = points.length
    ? `M ${points[0]!.x} ${baseline} L ${points
        .map((point) => `${point.x} ${point.y}`)
        .join(" L ")} L ${points.at(-1)!.x} ${baseline} Z`
    : "";
  const total = props.days.reduce((sum, day) => sum + day.conversations, 0);

  return (
    <Card>
      <div className="border-b border-white/[0.06] px-4 py-4 sm:px-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="m-0 font-mono text-[0.68rem] font-medium uppercase tracking-[0.14em] text-dashboard-text-muted">
              Conversation activity
            </h3>
            <p className="mt-1 mb-0 font-mono text-[0.64rem] leading-relaxed text-dashboard-text-muted">
              Root conversations with recorded activity, bucketed by day.
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-display text-xl font-light text-dashboard-text">
              {formatCompactNumber(total)}
            </div>
            <div className="font-mono text-[0.56rem] uppercase tracking-[0.1em] text-dashboard-text-muted">
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
          <defs>
            <linearGradient id="conversation-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.32" />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="conversation-line" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#22d3ee" />
              <stop offset="55%" stopColor="#67e8f9" />
              <stop offset="100%" stopColor="#a78bfa" />
            </linearGradient>
          </defs>
          <ActivityChartGrid layout={layout} maximum={maximum} />
          {area ? <path d={area} fill="url(#conversation-area)" /> : null}
          {line ? (
            <polyline
              fill="none"
              points={line}
              stroke="url(#conversation-line)"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.5"
            />
          ) : null}
          {props.days.map((day, index) => {
            const point = points[index]!;
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
                <circle
                  aria-label={`${formatActivityDate(day.date)}: ${day.conversations} conversations`}
                  cx={point.x}
                  cy={point.y}
                  fill="#22d3ee"
                  opacity={props.days.length > 30 ? 0.35 : 0.75}
                  r={props.days.length > 30 ? 3 : 4}
                  tabIndex={0}
                />
              </Tooltip>
            );
          })}
          <ActivityChartDateLabels
            dates={props.days.map((day) => day.date)}
            layout={layout}
            xPosition={(index) => points[index]?.x ?? layout.left}
          />
        </svg>
      </div>
    </Card>
  );
}
