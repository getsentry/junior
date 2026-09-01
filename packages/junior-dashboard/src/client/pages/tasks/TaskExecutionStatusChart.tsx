import type { TaskExecutionStatusDay } from "@sentry/junior/api/schema";
import {
  ActivityChartDateLabels,
  ActivityChartGrid,
  ActivityChartTooltip,
  ActivityTooltipRows,
  ChartSvg,
  createActivityChartLayout,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import {
  type TimeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";

const series = [
  { color: "#6ee7b7", key: "completed", label: "Completed" },
  { color: "#fda4af", key: "failed", label: "Failed" },
  { color: "#fcd34d", key: "blocked", label: "Blocked" },
] as const;

/** Render one task's terminal executions stacked by status over a trailing window. */
export function TaskExecutionStatusChart(props: {
  bucketUnit?: TimeRangeBucketUnit;

  days: TaskExecutionStatusDay[];
  range: TimeRangeDays;
}) {
  const bucketUnit = props.bucketUnit ?? "day";

  const days = props.days;
  const layout = createActivityChartLayout(220);
  const totals = days.map((day) => day.completed + day.failed + day.blocked);
  const maximum = Math.max(1, ...totals);
  const step =
    days.length > 0 ? layout.plotWidth / days.length : layout.plotWidth;
  const barWidth = Math.max(2, Math.min(13, step * 0.68));
  const hasExecutions = totals.some((total) => total > 0);

  return (
    <Card className="min-h-[15rem] p-4 sm:p-5">
      <div>
        <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
          Executions over time
        </h2>
        <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
          {bucketUnit === "hour"
            ? "Terminal runs for this task each hour."
            : bucketUnit === "6hour"
              ? "Terminal runs for this task each 6 hours."
              : "Terminal runs for this task each day."}
        </p>
      </div>

      <ChartLegend ariaLabel="Task execution status legend" items={series} />

      <div className="relative mt-3 overflow-hidden">
        <ChartSvg
          aria-label={`Task executions during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
          className="min-h-40"
          layout={layout}
        >
          <ActivityChartGrid layout={layout} maximum={maximum} />
          {days.map((day, dayIndex) => {
            let stackedHeight = 0;
            const x = layout.left + dayIndex * step + (step - barWidth) / 2;
            const total = totals[dayIndex] ?? 0;
            return (
              <ActivityChartTooltip
                key={day.date}
                content={
                  <ActivityTooltipRows
                    rows={[
                      ["completed", day.completed],
                      ["failed", day.failed],
                      ["blocked", day.blocked],
                      ["total", total],
                    ]}
                  />
                }
                date={day.date}
                summary={`${day.completed} completed, ${day.failed} failed, ${day.blocked} blocked, ${total} total`}
              >
                <g
                  tabIndex={0}
                >
                  {series.map((item) => {
                    const value = day[item.key];
                    const segmentHeight = (value / maximum) * layout.plotHeight;
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
              </ActivityChartTooltip>
            );
          })}
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
