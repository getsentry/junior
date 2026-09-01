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
import { formatCostSummary } from "../../format";

const COST_COLOR = "#67e8f9";

/** Render linked conversation spend for completed task executions. */
export function TaskCostChart(props: {
  bucketUnit?: "day" | "hour";
  days: TaskExecutionDay[];
  range: TimeRangeDays;
}) {
  const bucketUnit = props.bucketUnit ?? "day";
  const days = props.days;
  // Cost charts need a wider left gutter for currency tick labels.
  const layout = createActivityChartLayout(200, { left: 112 });
  const step =
    days.length > 0 ? layout.plotWidth / days.length : layout.plotWidth;
  const barWidth = Math.max(2, Math.min(13, step * 0.68));
  const totals = days.map((day) => day.costUsd);
  const total = totals.reduce((sum, value) => sum + value, 0);
  const maximum = Math.max(0.01, ...totals);
  const average = activityChartAverage(totals);
  const hasCost = totals.some((value) => value > 0);

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div>
        <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
          {formatCostSummary({ total }) || "$0.00"}
        </h2>
        <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
          Spend from conversations linked to completed task executions.
        </p>
      </div>

      <div className="relative mt-5 overflow-hidden">
        <ChartSvg
          aria-label={`Task execution spend during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
          className="min-h-40"
          layout={layout}
        >
          <ActivityChartGrid
            format={(value) => formatCostSummary({ total: value })}
            layout={layout}
            maximum={maximum}
          />
          {days.map((day, dayIndex) => {
            const x = layout.left + dayIndex * step + (step - barWidth) / 2;
            const value = totals[dayIndex] ?? 0;
            const height = (value / maximum) * layout.plotHeight;
            return (
              <Tooltip
                content={
                  <ActivityTooltipRows
                    rows={[["spend", formatCostSummary({ total: value })]]}
                  />
                }
                key={day.date}
                label={formatActivityDate(day.date)}
              >
                <g
                  aria-label={`${formatActivityDate(day.date)}: ${formatCostSummary({ total: value })}`}
                  tabIndex={0}
                >
                  <rect
                    fill={COST_COLOR}
                    height={height}
                    opacity={value > 0 ? 0.82 : 0.1}
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
            format={(value) => formatCostSummary({ total: value })}
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
        {!hasCost ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-mono text-xs text-dashboard-text-muted">
            No linked spend in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
