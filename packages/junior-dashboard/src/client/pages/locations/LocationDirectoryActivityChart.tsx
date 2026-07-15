import type { LocationActivityDayReport } from "@sentry/junior/api/schema";

import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";

function shortDate(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Compare public and privacy-preserving private conversation volume by day. */
export function LocationDirectoryActivityChart(props: {
  days: LocationActivityDayReport[];
}) {
  const width = 960;
  const height = 260;
  const left = 42;
  const right = 18;
  const top = 24;
  const bottom = 36;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maximum = Math.max(
    1,
    ...props.days.flatMap((day) => [
      day.privateConversations,
      day.publicConversations,
    ]),
  );
  const step = plotWidth / Math.max(1, props.days.length);
  const groupWidth = Math.max(3, Math.min(18, step * 0.8));
  const gap = Math.min(2, groupWidth * 0.15);
  const barWidth = Math.max(1.5, (groupWidth - gap) / 2);
  const labelIndexes = [
    ...new Set([
      0,
      Math.floor((props.days.length - 1) / 2),
      props.days.length - 1,
    ]),
  ].filter((index) => index >= 0);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.06] px-4 py-4 sm:px-5">
        <div>
          <h3 className="m-0 font-mono text-[0.68rem] font-medium uppercase tracking-[0.14em] text-white/60">
            Conversations per day
          </h3>
          <p className="mt-1 mb-0 font-mono text-[0.68rem] leading-relaxed text-white/30">
            Daily public volume compared with private activity in aggregate.
          </p>
        </div>
        <div className="flex items-center gap-4 font-mono text-[0.64rem] text-white/35">
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-sm bg-cyan-400" /> public
          </span>
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-sm bg-amber-400" /> private
          </span>
        </div>
      </div>
      <div className="px-2 py-3 sm:px-4 sm:py-4">
        <svg
          aria-label="Public and private conversations per day"
          className="block h-auto min-h-56 w-full overflow-visible"
          role="img"
          viewBox={`0 0 ${width} ${height}`}
        >
          {[0, 0.5, 1].map((ratio) => {
            const y = top + ratio * plotHeight;
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
                  fill="rgba(255,255,255,0.3)"
                  fontFamily="ui-monospace, monospace"
                  fontSize="10"
                  textAnchor="end"
                  x={left - 8}
                  y={y + 3}
                >
                  {Math.round(maximum * (1 - ratio))}
                </text>
              </g>
            );
          })}
          {props.days.flatMap((day, index) => {
            const groupX = left + index * step + (step - groupWidth) / 2;
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
              const barHeight = (bar.count / maximum) * plotHeight;
              return (
                <Tooltip
                  content={
                    <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
                      <span className="text-white/40">public</span>
                      <span className="text-right text-white/80">
                        {day.publicConversations}
                      </span>
                      <span className="text-white/40">private</span>
                      <span className="text-right text-white/80">
                        {day.privateConversations}
                      </span>
                    </div>
                  }
                  key={`${day.date}-${bar.key}`}
                  label={shortDate(day.date)}
                >
                  <rect
                    aria-label={`${shortDate(day.date)}: ${day.publicConversations} public conversations, ${day.privateConversations} private conversations`}
                    fill={bar.fill}
                    height={Math.max(bar.count ? 2 : 0, barHeight)}
                    opacity={bar.count ? 0.85 : 0.12}
                    rx="1.5"
                    tabIndex={0}
                    width={barWidth}
                    x={bar.x}
                    y={top + plotHeight - barHeight}
                  />
                </Tooltip>
              );
            });
          })}
          {labelIndexes.map((index) => {
            const day = props.days[index];
            if (!day) return null;
            return (
              <text
                fill="rgba(255,255,255,0.3)"
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
                x={left + index * step + step / 2}
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
