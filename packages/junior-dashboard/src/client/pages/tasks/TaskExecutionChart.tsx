import type { TaskExecutionDay } from "@sentry/junior/api/schema";
import {
  ActivityChartAverageLine,
  ActivityChartDateLabels,
  ActivityChartGrid,
  activityChartAverage,
  ActivityTooltipRows,
  ChartSvg,
  createActivityChartLayout,
  formatActivityTooltipDate,
} from "../../components/charts/ActivityChart";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";
import { formatActivityChartAverage } from "../../format";

const EXECUTION_COLOR = "#fbbf24";

/** Render completed task executions over a trailing window. */
export function TaskExecutionChart(props: {
  bucketUnit?: "day" | "hour";

  days: TaskExecutionDay[];
  range: TimeRangeDays;
}) {
  const bucketUnit = props.bucketUnit ?? "day";

  const days = props.days;
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
          Executions over time
        </h2>
        <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
          Completed task executions each day.
        </p>
      </div>

      <div className="relative mt-5 overflow-hidden">
        <ChartSvg
          aria-label={`Task executions during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
          className="min-h-40"
          layout={layout}
        >
          <ActivityChartGrid layout={layout} maximum={maximum} />
          {days.map((day, dayIndex) => {
            const x = layout.left + dayIndex * step + (step - barWidth) / 2;
            const total = totals[dayIndex] ?? 0;
            const height = (total / maximum) * layout.plotHeight;
            return (
              <Tooltip
                content={<ActivityTooltipRows rows={[["executions", total]]} />}
                key={day.date}
                label={formatActivityTooltipDate(day.date)}
              >
                <g
                  aria-label={`${formatActivityTooltipDate(day.date)}: ${total} executions`}
                  tabIndex={0}
                >
                  <rect
                    fill={EXECUTION_COLOR}
                    height={height}
                    opacity={0.82}
                    rx="1"
                    width={barWidth}
                    x={x}
                    y={layout.top + layout.plotHeight - height}
                  />
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
            unit={bucketUnit}
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
        {!hasExecutions ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-mono text-xs text-dashboard-text-muted">
            No task executions in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
