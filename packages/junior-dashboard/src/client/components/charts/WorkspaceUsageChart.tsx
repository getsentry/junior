import { Bar, BarChart, CartesianGrid } from "recharts";
import {
  ActivityChartAverageLine,
  activityChartAverage,
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "./ActivityChart";
import { ChartHeader } from "./ChartHeader";
import type { TimeRangeDays } from "../controls/TimeRangeSelector";
import { Card } from "../layout/Card";
import { ChartContainer, ChartTooltip } from "../ui/chart";
import { formatActivityChartAverage, formatCompactNumber } from "../../format";
import type { WorkspaceUsageDay } from "./workspaceUsage";

const USAGE_COLOR = "var(--color-violet-400)";
const chartConfig = { count: { color: USAGE_COLOR, label: "Usage" } };

/** Plot successful Workspace switches for one recipe over a trailing window. */
export function WorkspaceUsageChart(props: {
  days: WorkspaceUsageDay[];
  range: TimeRangeDays;
  workspaceName: string;
}) {
  const values = props.days.map((day) => day.count);
  const maximum = Math.max(1, ...values);
  const average = activityChartAverage(values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const hasUsage = total > 0;

  return (
    <Card>
      <ChartHeader
        description={`Successful switches into “${props.workspaceName}”.`}
        title="Usage"
        total={formatCompactNumber(total)}
        totalLabel={`last ${props.range} days`}
      />
      <div className="relative px-2 py-3 sm:px-4 sm:py-4">
        <ChartContainer
          className="aspect-auto h-50 w-full"
          config={chartConfig}
        >
          <BarChart
            aria-label={`Usage for ${props.workspaceName} during the last ${props.range} days`}
            data={props.days}
            margin={activityChartMargin}
            role="img"
          >
            <CartesianGrid strokeDasharray="3 5" vertical={false} />
            <ActivityChartYAxis maximum={maximum} />
            <ActivityChartXAxis keys={props.days.map((day) => day.date)} />
            <ChartTooltip
              content={
                <ActivityChartTooltipContent
                  rows={(day: WorkspaceUsageDay) => [["usage", day.count]]}
                />
              }
            />
            <Bar
              dataKey="count"
              fill="var(--color-count)"
              fillOpacity={0.82}
              isAnimationActive={false}
              maxBarSize={13}
              minPointSize={(value) => (value ? 2 : 0)}
              radius={2}
            />
            <ActivityChartAverageLine
              average={average}
              format={formatActivityChartAverage}
              stroke={USAGE_COLOR}
            />
          </BarChart>
        </ChartContainer>
        {!hasUsage ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-sans text-xs text-dashboard-text-muted">
            No usage in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
