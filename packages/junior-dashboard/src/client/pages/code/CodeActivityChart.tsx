import type { CodeActivityDay } from "@sentry/junior/api/schema";
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
import { ChartLegend } from "../../components/charts/ChartLegend";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";
import { formatActivityChartAverage } from "../../format";

const CREATED_COLOR = "#67e8f9";
const MERGED_COLOR = "#6ee7b7";
const CLOSED_COLOR = "#fb7185";

/** Render created, merged, and closed code changes over a trailing window. */
export function CodeActivityChart(props: {
  days: CodeActivityDay[];
  range: TimeRangeDays;
}) {
  const days = props.days.slice(-props.range);
  const layout = createActivityChartLayout(220, { left: 40 });
  const step =
    days.length > 0 ? layout.plotWidth / days.length : layout.plotWidth;
  const barWidth = Math.max(2, Math.min(10, step * 0.28));
  const gap = Math.max(1, barWidth * 0.2);
  const groupWidth = barWidth * 3 + gap * 2;
  const totals = days.map((day) => day.created + day.merged + day.closed);
  const maximum = Math.max(1, ...days.flatMap((day) => [day.created, day.merged, day.closed]));
  const average = activityChartAverage(days.map((day) => day.created));
  const hasActivity = totals.some((total) => total > 0);

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
            Changes over time
          </h2>
          <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
            Code changes created, merged, and closed each day.
          </p>
        </div>
        <ChartLegend
          ariaLabel="Code change legend"
          items={[
            { color: CREATED_COLOR, key: "created", label: "Created" },
            { color: MERGED_COLOR, key: "merged", label: "Merged" },
            { color: CLOSED_COLOR, key: "closed", label: "Closed" },
          ]}
        />
      </div>

      <div className="relative mt-5 overflow-hidden">
        <ChartSvg
          aria-label={`Code changes during the last ${props.range} days`}
          className="min-h-40"
          layout={layout}
        >
          <ActivityChartGrid layout={layout} maximum={maximum} />
          {days.map((day, dayIndex) => {
            const groupX =
              layout.left + dayIndex * step + (step - groupWidth) / 2;
            const series = [
              {
                color: CREATED_COLOR,
                key: "created",
                label: "created",
                value: day.created,
              },
              {
                color: MERGED_COLOR,
                key: "merged",
                label: "merged",
                value: day.merged,
              },
              {
                color: CLOSED_COLOR,
                key: "closed",
                label: "closed",
                value: day.closed,
              },
            ] as const;
            return (
              <Tooltip
                content={
                  <ActivityTooltipRows
                    rows={series.map((entry) => [entry.label, entry.value])}
                  />
                }
                key={day.date}
                label={formatActivityDate(day.date)}
              >
                <g
                  aria-label={`${formatActivityDate(day.date)}: ${day.created} created, ${day.merged} merged, ${day.closed} closed`}
                  tabIndex={0}
                >
                  {series.map((entry, seriesIndex) => {
                    const height = (entry.value / maximum) * layout.plotHeight;
                    const x = groupX + seriesIndex * (barWidth + gap);
                    return (
                      <rect
                        fill={entry.color}
                        height={height}
                        key={entry.key}
                        opacity={0.86}
                        rx="1"
                        width={barWidth}
                        x={x}
                        y={layout.top + layout.plotHeight - height}
                      />
                    );
                  })}
                  <rect
                    fill="transparent"
                    height={layout.plotHeight}
                    width={Math.max(groupWidth, 8)}
                    x={groupX - (Math.max(groupWidth, 8) - groupWidth) / 2}
                    y={layout.top}
                  />
                </g>
              </Tooltip>
            );
          })}
          <ActivityChartAverageLine
            average={average}
            format={formatActivityChartAverage}
            layout={layout}
            maximum={maximum}
            stroke="#e2e8f0"
          />
          <ActivityChartDateLabels
            dates={days.map((day) => day.date)}
            layout={layout}
            xPosition={(index) => layout.left + index * step + step / 2}
          />
        </ChartSvg>
        {!hasActivity ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-mono text-xs text-dashboard-text-muted">
            No code changes in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
