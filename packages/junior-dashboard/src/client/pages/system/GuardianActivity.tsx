import { timeRangeBucketAdjective } from "../../components/controls/TimeRangeSelector";
import type { GuardianMetricDay } from "@sentry/junior/api/schema";

import {
  ChartAxisHtmlLabel,
  formatActivityDate,
  ActivityChartTooltip,
} from "../../components/charts/ActivityChart";
import { Card } from "../../components/layout/Card";
import { formatCompactNumber, formatCostSummary } from "../../format";

function totals(days: GuardianMetricDay[]) {
  return days.reduce(
    (result, day) => ({
      allow: result.allow + day.allow,
      ask: result.ask + day.ask,
      costUsd: result.costUsd + (day.costUsd ?? 0),
      deny: result.deny + day.deny,
      requests: result.requests + day.requests,
    }),
    { allow: 0, ask: 0, costUsd: 0, deny: 0, requests: 0 },
  );
}

function Stat(props: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-md border border-white/[0.05] bg-black/10 px-3 py-3">
      <div className="font-display text-xl font-light text-dashboard-text">
        <span className={props.valueClassName}>{props.value}</span>
      </div>
      <div className="mt-1 font-mono text-xs leading-relaxed text-dashboard-text-muted">
        {props.label}
      </div>
    </div>
  );
}

/** Show Guardian request volume, result mix, and estimated cost by bucket. */
export function GuardianActivity(props: {
  bucketUnit?: "day" | "hour" | "6hour" | "6hour";
  days: GuardianMetricDay[];
}) {
  const bucketUnit = props.bucketUnit ?? "day";
  const period = totals(props.days);
  const maximum = Math.max(1, ...props.days.map((day) => day.requests));
  const labels = [
    0,
    Math.floor((props.days.length - 1) / 2),
    props.days.length - 1,
  ].filter(
    (index, position, indexes) =>
      index >= 0 && indexes.indexOf(index) === position,
  );

  return (
    <Card>
      <div className="border-b border-white/[0.06] px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="m-0 font-mono text-xs font-medium uppercase tracking-[0.14em] text-dashboard-text-muted">
              Guardian reviews
            </h3>
            <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
              {timeRangeBucketAdjective(bucketUnit)} decisions before
              reviewed actions execute.
            </p>
          </div>
          <div className="font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
            <span className="mr-3 text-emerald-200/75">Allow</span>
            <span className="mr-3 text-amber-200/75">Ask</span>
            <span className="text-rose-200/75">Deny</span>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label="Requests" value={formatCompactNumber(period.requests)} />
          <Stat
            label="Allowed"
            value={formatCompactNumber(period.allow)}
            valueClassName="text-emerald-100"
          />
          <Stat
            label="Asked"
            value={formatCompactNumber(period.ask)}
            valueClassName="text-amber-100"
          />
          <Stat
            label="Denied"
            value={formatCompactNumber(period.deny)}
            valueClassName="text-rose-100"
          />
          <Stat
            label="Estimated cost"
            value={formatCostSummary({ total: period.costUsd })}
          />
        </div>
      </div>
      <div className="px-4 pt-5 pb-3">
        <div
          aria-label={`${timeRangeBucketAdjective(bucketUnit)} Guardian review results`}
          className="flex h-36 items-end gap-px"
          role="img"
        >
          {props.days.map((day) => {
            const height = Math.max(2, (day.requests / maximum) * 100);
            return (
              <ActivityChartTooltip
                key={day.date}
                content={
                  <div className="grid grid-cols-[auto_auto] gap-x-4">
                    <span>Allow</span>
                    <span className="text-right">{day.allow}</span>
                    <span>Ask</span>
                    <span className="text-right">{day.ask}</span>
                    <span>Deny</span>
                    <span className="text-right">{day.deny}</span>
                    <span>Cost</span>
                    <span className="text-right">
                      {formatCostSummary({ total: day.costUsd ?? 0 })}
                    </span>
                  </div>
                }
                date={day.date}
                summary={`${day.allow} allowed, ${day.ask} asked, ${day.deny} denied, ${formatCostSummary({ total: day.costUsd ?? 0 })}`}
                triggerClassName="h-full min-w-0 flex-1 items-end"
              >
                <button
                  className="flex w-full min-w-0 flex-col justify-end overflow-hidden rounded-t-sm bg-white/[0.035] focus-visible:outline-1 focus-visible:outline-cyan-300"
                  style={{ height: `${height}%` }}
                  type="button"
                >
                  {day.deny ? (
                    <span
                      className="block w-full bg-rose-400/75"
                      style={{ flex: day.deny }}
                    />
                  ) : null}
                  {day.ask ? (
                    <span
                      className="block w-full bg-amber-300/75"
                      style={{ flex: day.ask }}
                    />
                  ) : null}
                  {day.allow ? (
                    <span
                      className="block w-full bg-emerald-300/70"
                      style={{ flex: day.allow }}
                    />
                  ) : null}
                </button>
              </ActivityChartTooltip>
            );
          })}
        </div>
        <div className="relative mt-2 h-4">
          {labels.map((index) => {
            const day = props.days[index];
            if (!day) return null;
            return (
              <ChartAxisHtmlLabel
                className="absolute -translate-x-1/2"
                key={day.date}
                style={{
                  left: `${((index + 0.5) / props.days.length) * 100}%`,
                }}
              >
                {formatActivityDate(day.date)}
              </ChartAxisHtmlLabel>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
