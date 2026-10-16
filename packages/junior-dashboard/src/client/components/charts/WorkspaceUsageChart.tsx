import {
  activityChartAverage,
  ActivityTooltipRows,
  ChartBar,
  ChartBucket,
  ChartFrame,
  chartPercent,
} from "./ActivityChart";
import { ChartHeader } from "./ChartHeader";
import type { TimeRangeDays } from "../controls/TimeRangeSelector";
import { Card } from "../layout/Card";
import { formatActivityChartAverage, formatCompactNumber } from "../../format";
import type { WorkspaceUsageDay } from "./workspaceUsage";

const USAGE_COLOR = "#a78bfa";

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

  return (
    <Card>
      <ChartHeader
        description={`Successful switches into “${props.workspaceName}”.`}
        title="Usage"
        total={formatCompactNumber(total)}
        totalLabel={`last ${props.range} days`}
      />
      <div className="px-4 py-4">
        <ChartFrame
          aria-label={`Usage for ${props.workspaceName} during the last ${props.range} days`}
          average={{
            color: USAGE_COLOR,
            format: formatActivityChartAverage,
            value: average,
          }}
          buckets={props.days.map((day) => day.date)}
          empty={total > 0 ? undefined : "No usage in this period."}
          maximum={maximum}
        >
          {props.days.map((day) => (
            <ChartBucket
              bucket={day.date}
              content={<ActivityTooltipRows rows={[["usage", day.count]]} />}
              key={day.date}
              summary={`${day.count} switches`}
            >
              <ChartBar
                className="w-[68%] max-w-3.25 rounded-t-xs opacity-82"
                fill={USAGE_COLOR}
                percent={chartPercent(day.count, maximum)}
              />
            </ChartBucket>
          ))}
        </ChartFrame>
      </div>
    </Card>
  );
}
