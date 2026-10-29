import { useState } from "react";
import type { ConversationMetricDay } from "@sentry/junior/api/schema";

import { Card } from "../layout/Card";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { formatCompactNumber } from "../../format";
import {
  type TimeRangeBucketUnit,
  timeRangeBucketPerLabel,
} from "../controls/TimeRangeSelector";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import { ChartContainer, ChartTooltip } from "../ui/chart";
import {
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "./ActivityChart";
import { ChartHeader } from "./ChartHeader";
import { CacheWrites } from "./CacheWrites";
import {
  CACHE_INPUT_SERIES,
  cacheInputTotal,
  formatCacheShare,
  hasCacheActivity,
  summarizeCacheInput,
} from "./cache-input";

const chartConfig = {
  ...Object.fromEntries(
    CACHE_INPUT_SERIES.map(({ color, key, label }) => [key, { color, label }]),
  ),
  missing: { color: "var(--color-slate-400)", label: "Missing data" },
};

/** Show cache reuse and write volume without treating missing counters as zero. */
export function InputCacheChart(props: {
  bucketUnit: TimeRangeBucketUnit;
  days: ConversationMetricDay[];
}) {
  const [mode, setMode] = useState<"share" | "tokens">("share");
  const summary = summarizeCacheInput(props.days);
  const data = props.days.map((day) => {
    const total = cacheInputTotal(day);
    const plotted = Object.fromEntries(
      CACHE_INPUT_SERIES.map(({ key }) => {
        const value = day[key] ?? 0;
        return [
          key,
          mode === "share" ? (total ? (value / total) * 100 : 0) : value,
        ];
      }),
    );
    return {
      ...plotted,
      date: day.date,
      day,
      // A zero-height bar that `minPointSize` draws as a gray mark.
      missing: total === undefined && hasCacheActivity(day) ? 0 : undefined,
    };
  });
  const maximum =
    mode === "share"
      ? 100
      : Math.max(
          1,
          ...props.days.map((day) =>
            CACHE_INPUT_SERIES.reduce(
              (sum, { key }) => sum + (day[key] ?? 0),
              0,
            ),
          ),
        );

  return (
    <Card>
      <ChartHeader
        title="Input cache"
        trailing={
          <ToggleGroup
            aria-label="Cache chart display"
            onValueChange={([next]) => {
              if (next) setMode(next);
            }}
            value={[mode]}
          >
            <ToggleGroupItem value="share">Percent</ToggleGroupItem>
            <ToggleGroupItem value="tokens">Tokens</ToggleGroupItem>
          </ToggleGroup>
        }
      />
      <dl className="m-0 flex flex-wrap gap-x-5 gap-y-2 px-4 py-3 font-sans tabular-nums text-xs sm:px-5">
        {CACHE_INPUT_SERIES.map(({ key, label, color }) => (
          <div key={key} className="flex items-center gap-2">
            <dt className="flex items-center gap-1.5 text-dashboard-text-muted">
              <span
                aria-hidden="true"
                className="size-2 rounded-full"
                style={{ backgroundColor: color }}
              />
              {label}
            </dt>
            <dd className="m-0 tabular-nums text-dashboard-text">
              {formatCacheShare(summary.input[key], summary.total)}
            </dd>
          </div>
        ))}
      </dl>
      {summary.activePeriods === 0 ? (
        <p className="m-0 px-4 pb-2 font-sans tabular-nums text-xs text-dashboard-text-muted sm:px-5">
          No input data in this time window.
        </p>
      ) : summary.incompletePeriods > 0 ? (
        <p className="m-0 px-4 pb-2 font-sans tabular-nums text-xs text-dashboard-text-muted sm:px-5">
          Missing data in {summary.incompletePeriods} of {summary.activePeriods}{" "}
          active time intervals. Percentages are unavailable; Tokens shows the
          reported values.
        </p>
      ) : null}
      <div className="px-2 pb-2">
        <ChartContainer
          className="aspect-auto h-40 w-full"
          config={chartConfig}
        >
          <BarChart
            aria-label={`Input cache ${mode} per ${timeRangeBucketPerLabel(props.bucketUnit)}`}
            data={data}
            margin={activityChartMargin}
            role="img"
          >
            <CartesianGrid strokeDasharray="3 5" vertical={false} />
            <ActivityChartYAxis
              format={
                mode === "share" ? (value) => `${value}%` : formatCompactNumber
              }
              maximum={maximum}
            />
            <ActivityChartXAxis keys={data.map((day) => day.date)} />
            {/* A hidden second axis lets the missing mark overlay the stack. */}
            <XAxis dataKey="date" hide xAxisId="missing" />
            <ChartTooltip
              content={
                <ActivityChartTooltipContent
                  rows={({ day }: (typeof data)[number]) => {
                    const total = cacheInputTotal(day);
                    return CACHE_INPUT_SERIES.map(({ key, label }) => [
                      label,
                      day[key] === undefined
                        ? "Not reported"
                        : `${formatCompactNumber(day[key])} · ${formatCacheShare(day[key], total)}`,
                    ]);
                  }}
                />
              }
            />
            {CACHE_INPUT_SERIES.map(({ key }) => (
              <Bar
                dataKey={key}
                fill={`var(--color-${key})`}
                fillOpacity={0.85}
                isAnimationActive={false}
                key={key}
                maxBarSize={32}
                stackId="input"
              />
            ))}
            <Bar
              dataKey="missing"
              fill="var(--color-missing)"
              isAnimationActive={false}
              maxBarSize={32}
              minPointSize={3}
              xAxisId="missing"
            />
          </BarChart>
        </ChartContainer>
      </div>
      <CacheWrites days={props.days} bucketUnit={props.bucketUnit} />
      <details className="border-t border-dashboard-border-subtle px-4 py-3 font-sans tabular-nums text-xs text-dashboard-text-muted sm:px-5">
        <summary className="cursor-pointer text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus">
          How to read this
        </summary>
        <div className="mt-3 grid gap-2 leading-relaxed">
          <p className="m-0">
            From cache is input reused. Written to cache is input saved for
            reuse. Uncached is the remaining input.
          </p>
          <p className="m-0">
            Percentages use total input tokens, not call counts. Gray marks and
            — mean missing data; zero means a reported zero. The latest interval
            may be incomplete.
          </p>
          <p className="m-0">
            These totals can show when reuse changes, but not why. They do not
            show individual calls or prove that every call reported cache use.
          </p>
        </div>
      </details>
    </Card>
  );
}
