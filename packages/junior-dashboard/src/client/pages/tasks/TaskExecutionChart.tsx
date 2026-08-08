import type { TaskExecutionDay } from "@sentry/junior/api/schema";
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
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";
import { formatCompactNumber } from "../../format";

const series = [
  { color: "#6ee7b7", key: "scheduled", label: "Scheduled" },
  { color: "#c4b5fd", key: "event", label: "Event" },
] as const;

/** Render completed task executions stacked by type over a trailing window. */
export function TaskExecutionChart(props: {
  days: TaskExecutionDay[];
  range: TimeRangeDays;
}) {
  const days = props.days.slice(-props.range);
  const layout = createActivityChartLayout(200);
  const step =
    days.length > 0 ? layout.plotWidth / days.length : layout.plotWidth;
  const barWidth = Math.max(2, Math.min(13, step * 0.68));
  const totals = days.map((day) => day.scheduled + day.event);
  const maximum = Math.max(1, ...totals);
  const average = activityChartAverage(totals);
  const hasExecutions = totals.some((total) => total > 0);

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div>
        <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
          Activity over time
        </h2>
        <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
          Completed scheduled and event task runs each day.
        </p>
      </div>

      <div
        aria-label="Task execution legend"
        className="mt-4 flex flex-wrap gap-4"
      >
        {series.map((item) => (
          <span
            className="inline-flex items-center gap-1.5 font-mono text-xs text-dashboard-text-muted"
            key={item.key}
          >
            <i
              className="size-2 rounded-sm"
              style={{ backgroundColor: item.color }}
            />
            {item.label}
          </span>
        ))}
      </div>

      <div className="relative mt-3 overflow-hidden">
        <ChartSvg
          aria-label={`Task executions during the last ${props.range} days`}
          className="min-h-40"
          layout={layout}
        >
          <ActivityChartGrid layout={layout} maximum={maximum} />
          {days.map((day, dayIndex) => {
            let stackedHeight = 0;
            const x = layout.left + dayIndex * step + (step - barWidth) / 2;
            const total = totals[dayIndex] ?? 0;
            return (
              <Tooltip
                content={
                  <ActivityTooltipRows
                    rows={[
                      ["scheduled", day.scheduled],
                      ["event", day.event],
                      ["total", total],
                    ]}
                  />
                }
                key={day.date}
                label={formatActivityDate(day.date)}
              >
                <g
                  aria-label={`${formatActivityDate(day.date)}: ${day.scheduled} scheduled, ${day.event} event, ${total} total executions`}
                  tabIndex={0}
                >
                  {series.map((item) => {
                    const value = day[item.key];
                    const segmentHeight =
                      (value / maximum) * layout.plotHeight;
                    stackedHeight += segmentHeight;
                    return (
                      <rect
                        fill={item.color}
                        height={segmentHeight}
                        key={item.key}
                        opacity={0.82}
                        rx="1"
                        width={barWidth}
                        x={x}
                        y={layout.top + layout.plotHeight - stackedHeight}
                      />
                    );
                  })}
                  <rect
                    fill="transparent"
                    height={layout.plotHeight}
                    width={Math.max(barWidth, 8)}
                    x={x - (Math.max(barWidth, 8) - barWidth) / 2}
                    y={layout.top}
                  />
                </g>
              </Tooltip>
            );
          })}
          <ActivityChartAverageLine
            average={average}
            format={formatCompactNumber}
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
        {!hasExecutions ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-mono text-xs text-dashboard-text-muted">
            No task executions in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
