import type {
  AutomationExecutionStatusDay,
  AutomationSummary,
} from "@sentry/junior/api/schema";

import {
  ActivityChartTooltip,
  ActivityTooltipRows,
} from "../../components/charts/ActivityChart";
import { Fact, FactList, FactSection } from "../../components/FactSection";
import { formatCostSummary } from "../../format";

const COST_DAYS = 30;

/**
 * What the Automation costs: a 30-day daily spend strip, the total since it
 * was created, and the 30-day averages per day and per run. Cost is the
 * linked Conversation spend, so blocked runs count as free.
 */
export function AutomationCost(props: {
  automation: AutomationSummary;
  days: readonly AutomationExecutionStatusDay[] | undefined;
}) {
  const { automation } = props;
  const recent = automation.costUsd[30];
  const recentRuns = automation.runs[30];
  const usd = (total: number) => formatCostSummary({ total });
  return (
    <FactSection title="Cost">
      {props.days ? <DailyCost days={props.days.slice(-COST_DAYS)} /> : null}
      <FactList>
        <Fact label="Total">
          {usd(automation.totalCostUsd)}
          <span className="text-dashboard-text-muted">
            {" "}
            · {automation.totalRuns}{" "}
            {automation.totalRuns === 1 ? "run" : "runs"}
          </span>
        </Fact>
        <Fact label="Last 30 days">{usd(recent)}</Fact>
        <Fact label="Average per day">{usd(recent / COST_DAYS)}</Fact>
        <Fact label="Average per run">
          {recentRuns > 0 ? usd(recent / recentRuns) : "—"}
        </Fact>
      </FactList>
    </FactSection>
  );
}

/** One bar per UTC day, scaled to the most expensive day shown. */
function DailyCost(props: { days: readonly AutomationExecutionStatusDay[] }) {
  const highest = Math.max(0, ...props.days.map((day) => day.costUsd));
  return (
    <div
      aria-label={`Daily cost, last ${props.days.length} days`}
      className="flex h-10 items-end gap-0.5"
      role="img"
    >
      {props.days.map((day) => {
        const runs = day.completed + day.failed + day.blocked;
        const cost = formatCostSummary({ total: day.costUsd });
        return (
          <ActivityChartTooltip
            content={
              <ActivityTooltipRows
                rows={[
                  ["Cost", cost],
                  ["Runs", runs],
                ]}
              />
            }
            date={day.date}
            key={day.date}
          >
            {/* The whole column opens the tooltip, so empty days are easy to hit. */}
            <span className="group flex h-full flex-1 items-end">
              <span
                className={
                  day.costUsd > 0
                    ? "block w-full rounded-[1px] bg-chart-1 opacity-80 group-hover:opacity-100"
                    : "block h-0.5 w-full rounded-full bg-dashboard-fill-strong"
                }
                style={
                  day.costUsd > 0 && highest > 0
                    ? {
                        height: `${Math.max(8, Math.round((day.costUsd / highest) * 100))}%`,
                      }
                    : undefined
                }
              />
            </span>
          </ActivityChartTooltip>
        );
      })}
    </div>
  );
}
