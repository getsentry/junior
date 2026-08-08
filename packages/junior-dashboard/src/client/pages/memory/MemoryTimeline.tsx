import {
  ActivityChartDateLabels,
  ActivityChartGrid,
  ActivityTooltipRows,
  createActivityChartLayout,
  formatActivityDate,
} from "../../components/charts/ActivityChart";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";
import type { MemoryDay } from "./memoryDashboard";

const series = [
  { color: "#67e8f9", key: "personal", label: "Personal" },
  { color: "#6ee7b7", key: "public", label: "Public" },
] as const;

/** Render viewer memory creation as a stacked personal/public timeline. */
export function MemoryTimeline(props: {
  days: MemoryDay[];
  range: TimeRangeDays;
}) {
  const days = props.days.slice(-props.range);
  const layout = createActivityChartLayout(200);
  const step = days.length > 0 ? layout.plotWidth / days.length : layout.plotWidth;
  const barWidth = Math.max(2, Math.min(13, step * 0.68));
  const totals = days.map((day) => day.personal + day.public);
  const maximum = Math.max(1, ...totals);
  const hasMemories = totals.some((total) => total > 0);

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div>
        <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
          Activity over time
        </h2>
        <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
          Stacked personal + public memories created each day.
        </p>
      </div>

      <div
        aria-label="Memory visibility legend"
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
        <svg
          aria-label={`Memories learned during the last ${props.range} days`}
          className="block h-auto min-h-40 w-full"
          role="img"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
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
                      ["personal", day.personal],
                      ["public", day.public],
                      ["total", total],
                    ]}
                  />
                }
                key={day.date}
                label={formatActivityDate(day.date)}
              >
                <g
                  aria-label={`${formatActivityDate(day.date)}: ${day.personal} personal, ${day.public} public, ${total} total memories`}
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
              </Tooltip>
            );
          })}
          <ActivityChartDateLabels
            dates={days.map((day) => day.date)}
            layout={layout}
            xPosition={(index) => layout.left + index * step + step / 2}
          />
        </svg>
        {!hasMemories ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-mono text-xs text-dashboard-text-muted">
            No memories were learned in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
