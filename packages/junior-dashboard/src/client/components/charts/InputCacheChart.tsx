import { useState } from "react";
import type { ConversationMetricDay } from "@sentry/junior/api/schema";

import { ToggleButton } from "../Button";
import { Card } from "../layout/Card";
import { formatCompactNumber } from "../../format";
import {
  type TimeRangeBucketUnit,
  timeRangeBucketPerLabel,
} from "../controls/TimeRangeSelector";
import {
  ActivityChartDateLabels,
  ActivityChartGrid,
  ActivityChartTooltip,
  ActivityTooltipRows,
  ChartSvg,
} from "./ActivityChart";
import { ChartHeader } from "./ChartHeader";
import { CacheWrites } from "./CacheWrites";
import { useChartLayout } from "./useChartLayout";
import {
  CACHE_INPUT_SERIES,
  cacheInputTotal,
  formatCacheShare,
  hasCacheActivity,
  summarizeCacheInput,
} from "./cache-input";

/** Show cache reuse and write volume without treating missing counters as zero. */
export function InputCacheChart(props: {
  bucketUnit: TimeRangeBucketUnit;
  days: ConversationMetricDay[];
}) {
  const [mode, setMode] = useState<"share" | "tokens">("share");
  const summary = summarizeCacheInput(props.days);
  const { ref, layout } = useChartLayout(160);
  const reportedTotals = props.days.map((day) =>
    CACHE_INPUT_SERIES.reduce((sum, { key }) => sum + (day[key] ?? 0), 0),
  );
  const maximum = mode === "share" ? 100 : Math.max(1, ...reportedTotals);
  const step = layout.plotWidth / Math.max(1, props.days.length);
  const barWidth = Math.min(32, step * 0.7);
  const x = (index: number) => layout.left + step * (index + 0.5);

  return (
    <Card>
      <ChartHeader
        title="Input cache"
        trailing={
          <div
            aria-label="Cache chart display"
            className="flex gap-1"
            role="group"
          >
            <ToggleButton
              pressed={mode === "share"}
              variant="segment"
              onClick={() => setMode("share")}
            >
              Percent
            </ToggleButton>
            <ToggleButton
              pressed={mode === "tokens"}
              variant="segment"
              onClick={() => setMode("tokens")}
            >
              Tokens
            </ToggleButton>
          </div>
        }
      />
      <dl className="m-0 flex flex-wrap gap-x-5 gap-y-2 px-4 py-3 font-mono text-xs sm:px-5">
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
        <p className="m-0 px-4 pb-2 font-mono text-xs text-dashboard-text-muted sm:px-5">
          No input data in this time window.
        </p>
      ) : summary.incompletePeriods > 0 ? (
        <p className="m-0 px-4 pb-2 font-mono text-xs text-dashboard-text-muted sm:px-5">
          Missing data in {summary.incompletePeriods} of {summary.activePeriods}{" "}
          active time intervals. Percentages are unavailable; Tokens shows the
          reported values.
        </p>
      ) : null}
      <div className="px-2 pb-2" ref={ref}>
        <ChartSvg
          aria-label={`Input cache ${mode} per ${timeRangeBucketPerLabel(props.bucketUnit)}`}
          layout={layout}
        >
          <ActivityChartGrid
            format={
              mode === "share" ? (value) => `${value}%` : formatCompactNumber
            }
            layout={layout}
            maximum={maximum}
          />
          {props.days.map((day, index) => {
            const total = cacheInputTotal(day);
            const incomplete = total === undefined && hasCacheActivity(day);
            let offset = 0;
            const bars = CACHE_INPUT_SERIES.map(({ key, color }) => {
              const value = day[key] ?? 0;
              const plotted =
                mode === "share" ? (total ? (value / total) * 100 : 0) : value;
              const height = (plotted / maximum) * layout.plotHeight;
              offset += height;
              return (
                <rect
                  key={key}
                  fill={color}
                  opacity={0.85}
                  height={height}
                  width={barWidth}
                  x={x(index) - barWidth / 2}
                  y={layout.top + layout.plotHeight - offset}
                />
              );
            });
            return (
              <ActivityChartTooltip
                key={day.date}
                date={day.date}
                summary={
                  incomplete
                    ? "Missing cache data"
                    : total === undefined
                      ? "No input reported"
                      : `${formatCacheShare(day.cachedInputTokens, total)} cached · ${formatCompactNumber(total)} input tokens`
                }
                content={
                  <ActivityTooltipRows
                    rows={CACHE_INPUT_SERIES.map(({ key, label }) => [
                      label,
                      day[key] === undefined
                        ? "Not reported"
                        : `${formatCompactNumber(day[key])} · ${formatCacheShare(day[key], total)}`,
                    ])}
                  />
                }
              >
                <g tabIndex={0}>
                  <rect
                    fill="transparent"
                    x={x(index) - step / 2}
                    y={layout.top}
                    width={step}
                    height={layout.plotHeight}
                  />
                  {bars}
                  {incomplete ? (
                    <rect
                      fill="#94a3b8"
                      x={x(index) - barWidth / 2}
                      y={layout.top + layout.plotHeight - 3}
                      width={barWidth}
                      height={3}
                    />
                  ) : null}
                </g>
              </ActivityChartTooltip>
            );
          })}
          <ActivityChartDateLabels
            dates={props.days.map((day) => day.date)}
            layout={layout}
            xPosition={x}
          />
        </ChartSvg>
      </div>
      <CacheWrites days={props.days} bucketUnit={props.bucketUnit} />
      <details className="border-t border-dashboard-border-subtle px-4 py-3 font-mono text-xs text-dashboard-text-muted sm:px-5">
        <summary className="cursor-pointer text-dashboard-text focus-visible:outline focus-visible:outline-cyan-300">
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
