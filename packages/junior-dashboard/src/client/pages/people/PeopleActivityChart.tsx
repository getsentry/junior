import type { PeopleActivityDayReport } from "@sentry/junior/api/schema";

import {
  ActivityChartAverageLine,
  ActivityChartDateLabels,
  ActivityChartGrid,
  activityChartAverage,
  ActivityTooltipRows,
  ChartSvg,
  createActivityChartLayout,
  formatActivityDate,
  type ActivityChartLayout,
} from "../../components/charts/ActivityChart";
import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";
import { Tooltip } from "../../components/Tooltip";
import { formatActivityChartAverage } from "../../format";

function chartPoint(
  day: PeopleActivityDayReport,
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
      (day.activePeople / maximum) * layout.plotHeight,
  };
}

/** Plot distinct verified people with recorded conversation activity each day. */
export function PeopleActivityChart(props: {
  days: PeopleActivityDayReport[];
}) {
  const layout = createActivityChartLayout(260);
  const values = props.days.map((day) => day.activePeople);
  const maximum = Math.max(1, ...values);
  const average = activityChartAverage(values);
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
  return (
    <Card>
      <CardHeader
        description="Distinct verified actors grouped by recorded conversation activity."
        title="Active people per day"
        trailing={
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.55)]" />
            people
          </span>
        }
      />
      <div className="px-2 py-3 sm:px-4 sm:py-4">
        <ChartSvg
          aria-label="Active people per day"
          className="min-h-56 w-full overflow-visible"
          layout={layout}
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
          <ActivityChartGrid layout={layout} maximum={maximum} />
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
                  <ActivityTooltipRows
                    rows={[
                      ["active people", day.activePeople],
                      ["conversations", day.conversations],
                    ]}
                  />
                }
                key={day.date}
                label={formatActivityDate(day.date)}
              >
                <circle
                  aria-label={`${formatActivityDate(day.date)}: ${day.activePeople} active people, ${day.conversations} conversations`}
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
          <ActivityChartAverageLine
            average={average}
            format={formatActivityChartAverage}
            layout={layout}
            maximum={maximum}
            stroke="#fbbf24"
          />
          <ActivityChartDateLabels
            dates={props.days.map((day) => day.date)}
            layout={layout}
            xPosition={(index) => points[index]?.x ?? layout.left}
          />
        </ChartSvg>
      </div>
    </Card>
  );
}
