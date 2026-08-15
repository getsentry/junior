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
import { ChartHeader } from "../../components/charts/ChartHeader";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";
import {
  formatActivityChartAverage,
  formatCompactNumber,
} from "../../format";
import type { WorkspaceSwitchDay } from "./workspaceSwitchStats";

const SWITCH_COLOR = "#a78bfa";

/** Plot successful Workspace switches for one recipe over a trailing window. */
export function WorkspaceSwitchChart(props: {
  days: WorkspaceSwitchDay[];
  range: TimeRangeDays;
  workspaceName: string;
}) {
  const layout = createActivityChartLayout(200);
  const step =
    props.days.length > 0
      ? layout.plotWidth / props.days.length
      : layout.plotWidth;
  const barWidth = Math.max(2, Math.min(13, step * 0.68));
  const values = props.days.map((day) => day.count);
  const maximum = Math.max(1, ...values);
  const average = activityChartAverage(values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const hasSwitches = total > 0;

  return (
    <Card>
      <ChartHeader
        description={`Successful switchWorkspace calls into “${props.workspaceName}”, bucketed by UTC day.`}
        title="Workspace switches"
        total={formatCompactNumber(total)}
        totalLabel={`last ${props.range} days`}
      />
      <div className="relative px-2 py-3 sm:px-4 sm:py-4">
        <ChartSvg
          aria-label={`Workspace switches for ${props.workspaceName} during the last ${props.range} days`}
          className="min-h-40 overflow-visible"
          layout={layout}
        >
          <ActivityChartGrid layout={layout} maximum={maximum} />
          {props.days.map((day, index) => {
            const x = layout.left + index * step + step / 2;
            const barHeight = (day.count / maximum) * layout.plotHeight;
            const renderedHeight = Math.max(day.count ? 2 : 0, barHeight);
            return (
              <Tooltip
                content={
                  <ActivityTooltipRows rows={[["switches", day.count]]} />
                }
                key={day.date}
                label={formatActivityDate(day.date)}
              >
                <g
                  aria-label={`${formatActivityDate(day.date)}: ${day.count} switches`}
                  tabIndex={0}
                >
                  <rect
                    fill={SWITCH_COLOR}
                    height={renderedHeight}
                    opacity={day.count ? 0.82 : 0.08}
                    rx="2"
                    width={barWidth}
                    x={x - barWidth / 2}
                    y={layout.top + layout.plotHeight - renderedHeight}
                  />
                  <rect
                    fill="transparent"
                    height={layout.plotHeight}
                    width={step}
                    x={layout.left + index * step}
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
            stroke={SWITCH_COLOR}
          />
          <ActivityChartDateLabels
            dates={props.days.map((day) => day.date)}
            layout={layout}
            xPosition={(index) => layout.left + index * step + step / 2}
          />
        </ChartSvg>
        {!hasSwitches ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-mono text-xs text-dashboard-text-muted">
            No Workspace switches in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
