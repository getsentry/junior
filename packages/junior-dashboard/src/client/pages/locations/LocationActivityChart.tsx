import type { DailyConversationActivity } from "@sentry/junior/api/schema";

import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";
import { Tooltip } from "../../components/Tooltip";

function shortDate(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Plot daily conversation volume across one public location. */
export function LocationActivityChart(props: {
  days: DailyConversationActivity[];
}) {
  const width = 960;
  const height = 240;
  const left = 42;
  const right = 18;
  const top = 24;
  const bottom = 36;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maximum = Math.max(1, ...props.days.map((day) => day.conversations));
  const step = plotWidth / Math.max(1, props.days.length);
  const barWidth = Math.max(4, Math.min(20, step * 0.55));
  const labelIndexes = [
    ...new Set([
      0,
      Math.floor((props.days.length - 1) / 2),
      props.days.length - 1,
    ]),
  ].filter((index) => index >= 0);

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
        <svg
          aria-label="Daily conversations for this location"
          className="block h-auto min-h-52 w-full overflow-visible"
          role="img"
          viewBox={`0 0 ${width} ${height}`}
        >
          <defs>
            <linearGradient id="location-bars" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#22d3ee" />
              <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.65" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((ratio) => {
            const y = top + ratio * plotHeight;
            const value = Math.round(maximum * (1 - ratio));
            return (
              <g key={ratio}>
                <line
                  stroke="rgba(255,255,255,0.07)"
                  strokeDasharray="3 5"
                  x1={left}
                  x2={width - right}
                  y1={y}
                  y2={y}
                />
                <text
                  fill="rgba(255,255,255,0.5)"
                  fontFamily="ui-monospace, monospace"
                  fontSize="10"
                  textAnchor="end"
                  x={left - 8}
                  y={y + 3}
                >
                  {value}
                </text>
              </g>
            );
          })}
          {props.days.map((day, index) => {
            const barHeight = (day.conversations / maximum) * plotHeight;
            const x = left + index * step + (step - barWidth) / 2;
            const y = top + plotHeight - barHeight;
            return (
              <Tooltip
                content={
                  <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
                    <span className="text-white/60">conversations</span>
                    <span className="text-right text-white/80">
                      {day.conversations}
                    </span>
                    <span className="text-white/60">active</span>
                    <span className="text-right text-white/80">
                      {day.active}
                    </span>
                    <span className="text-white/60">failed</span>
                    <span className="text-right text-white/80">
                      {day.failed}
                    </span>
                  </div>
                }
                key={day.date}
                label={shortDate(day.date)}
              >
                <rect
                  aria-label={`${shortDate(day.date)}: ${day.conversations} conversations, ${day.active} active, ${day.failed} failed`}
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
          {labelIndexes.map((index) => {
            const day = props.days[index];
            if (!day) return null;
            const x = left + index * step + step / 2;
            return (
              <text
                fill="rgba(255,255,255,0.5)"
                fontFamily="ui-monospace, monospace"
                fontSize="10"
                key={day.date}
                textAnchor={
                  index === 0
                    ? "start"
                    : index === props.days.length - 1
                      ? "end"
                      : "middle"
                }
                x={x}
                y={height - 8}
              >
                {shortDate(day.date)}
              </text>
            );
          })}
        </svg>
      </div>
    </Card>
  );
}
