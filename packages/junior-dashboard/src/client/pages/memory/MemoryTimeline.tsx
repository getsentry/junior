import {
  ActivityChartDateLabels,
  ActivityChartGrid,
  ActivityTooltipRows,
  ChartSvg,
  createActivityChartLayout,
  formatActivityDate,
} from "../../components/charts/ActivityChart";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";
import type { MemoryDay } from "./memoryDashboard";

/** Render public memory creation over time. */
export function MemoryTimeline(props: {
  days: MemoryDay[];
  range: TimeRangeDays;
}) {
  const days = props.days.slice(-props.range);
  const layout = createActivityChartLayout(200);
  const step =
    days.length > 0 ? layout.plotWidth / days.length : layout.plotWidth;
  const barWidth = Math.max(2, Math.min(13, step * 0.68));
  const totals = days.map((day) => day.memories);
  const maximum = Math.max(1, ...totals);
  const hasMemories = totals.some((total) => total > 0);

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div>
        <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
          Activity over time
        </h2>
        <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
          Public memories created each day.
        </p>
      </div>

      <div className="relative mt-3 overflow-hidden">
        <ChartSvg
          aria-label={`Memories learned during the last ${props.range} days`}
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
                content={<ActivityTooltipRows rows={[["memories", total]]} />}
                key={day.date}
                label={formatActivityDate(day.date)}
              >
                <g
                  aria-label={`${formatActivityDate(day.date)}: ${total} memories`}
                  tabIndex={0}
                >
                  <rect
                    fill="#6ee7b7"
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
          <ActivityChartDateLabels
            dates={days.map((day) => day.date)}
            layout={layout}
            xPosition={(index) => layout.left + index * step + step / 2}
          />
        </ChartSvg>
        {!hasMemories ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-mono text-xs text-dashboard-text-muted">
            No memories were learned in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
