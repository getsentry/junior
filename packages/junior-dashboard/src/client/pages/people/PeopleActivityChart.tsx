import type { PeopleActivityDayReport } from "@sentry/junior/api/schema";

import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";

function shortDate(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function chartPoint(
  day: PeopleActivityDayReport,
  index: number,
  count: number,
  maximum: number,
) {
  const left = 42;
  const right = 18;
  const top = 24;
  const bottom = 36;
  const width = 960;
  const height = 260;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  return {
    x: left + (index / Math.max(1, count - 1)) * plotWidth,
    y: top + plotHeight - (day.activePeople / maximum) * plotHeight,
  };
}

/** Plot distinct verified people with recorded conversation activity each day. */
export function PeopleActivityChart(props: {
  days: PeopleActivityDayReport[];
}) {
  const maximum = Math.max(1, ...props.days.map((day) => day.activePeople));
  const points = props.days.map((day, index) =>
    chartPoint(day, index, props.days.length, maximum),
  );
  const baseline = 224;
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = points.length
    ? `M ${points[0]!.x} ${baseline} L ${points
        .map((point) => `${point.x} ${point.y}`)
        .join(" L ")} L ${points.at(-1)!.x} ${baseline} Z`
    : "";
  const labelIndexes = [
    ...new Set([
      0,
      Math.floor((props.days.length - 1) / 2),
      props.days.length - 1,
    ]),
  ].filter((index) => index >= 0);

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-4 py-4 sm:px-5">
        <div>
          <h3 className="m-0 font-mono text-[0.68rem] font-medium uppercase tracking-[0.14em] text-white/60">
            Active people per day
          </h3>
          <p className="mt-1 mb-0 font-mono text-[0.68rem] leading-relaxed text-white/30">
            Distinct verified actors grouped by recorded conversation activity.
          </p>
        </div>
        <div className="flex items-center gap-2 font-mono text-[0.64rem] text-white/35">
          <span className="size-2 rounded-full bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.55)]" />
          people
        </div>
      </div>
      <div className="px-2 py-3 sm:px-4 sm:py-4">
        <svg
          aria-label="Active people per day"
          className="block h-auto min-h-56 w-full overflow-visible"
          role="img"
          viewBox="0 0 960 260"
        >
          <defs>
            <linearGradient id="people-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="people-line" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#f59e0b" />
              <stop offset="55%" stopColor="#fbbf24" />
              <stop offset="100%" stopColor="#22d3ee" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((ratio) => {
            const y = 24 + ratio * 200;
            const value = Math.round(maximum * (1 - ratio));
            return (
              <g key={ratio}>
                <line
                  stroke="rgba(255,255,255,0.07)"
                  strokeDasharray="3 5"
                  x1="42"
                  x2="942"
                  y1={y}
                  y2={y}
                />
                <text
                  fill="rgba(255,255,255,0.3)"
                  fontFamily="ui-monospace, monospace"
                  fontSize="10"
                  textAnchor="end"
                  x="34"
                  y={y + 3}
                >
                  {value}
                </text>
              </g>
            );
          })}
          {area ? <path d={area} fill="url(#people-area)" /> : null}
          {line ? (
            <polyline
              fill="none"
              points={line}
              stroke="url(#people-line)"
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
                  <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
                    <span className="text-white/40">active people</span>
                    <span className="text-right text-white/80">
                      {day.activePeople}
                    </span>
                    <span className="text-white/40">conversations</span>
                    <span className="text-right text-white/80">
                      {day.conversations}
                    </span>
                  </div>
                }
                key={day.date}
                label={shortDate(day.date)}
              >
                <circle
                  aria-label={`${shortDate(day.date)}: ${day.activePeople} active people, ${day.conversations} conversations`}
                  cx={point.x}
                  cy={point.y}
                  fill="#fbbf24"
                  opacity={props.days.length > 30 ? 0.35 : 0.75}
                  r={props.days.length > 30 ? 3 : 4}
                  tabIndex={0}
                />
              </Tooltip>
            );
          })}
          {labelIndexes.map((index) => {
            const day = props.days[index];
            const point = points[index];
            if (!day || !point) return null;
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
                x={point.x}
                y="248"
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
