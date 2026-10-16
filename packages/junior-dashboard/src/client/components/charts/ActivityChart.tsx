import {
  cloneElement,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";

import { Tooltip } from "../Tooltip";
import { getDashboardTimeZone } from "../../format";
import { cn } from "../../styles";

/** True when the bucket key is a UTC hour (`YYYY-MM-DDTHH`). */
export function isActivityHourBucket(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(date);
}

/** UTC start of a day (`YYYY-MM-DD`) or hour (`YYYY-MM-DDTHH`) bucket key. */
export function activityBucketStartMs(date: string): number {
  return Date.parse(
    isActivityHourBucket(date) ? `${date}:00:00.000Z` : `${date}T00:00:00.000Z`,
  );
}

/**
 * Format an activity day or hour bucket for chart axes.
 * Hour buckets use the dashboard display timezone. Day buckets keep the UTC
 * calendar key so a day series does not shift across local midnight.
 */
export function formatActivityDate(date: string): string {
  if (isActivityHourBucket(date)) {
    return new Date(`${date}:00:00.000Z`).toLocaleTimeString(undefined, {
      hour: "numeric",
      timeZone: getDashboardTimeZone(),
    });
  }
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * Format an activity day or hour bucket for chart tooltips and aria labels.
 * Hour buckets always include the local calendar date so 24h views are unambiguous.
 */
export function formatActivityTooltipDate(date: string): string {
  if (isActivityHourBucket(date)) {
    return new Date(`${date}:00:00.000Z`).toLocaleString(undefined, {
      day: "numeric",
      hour: "numeric",
      month: "short",
      timeZone: getDashboardTimeZone(),
    });
  }
  return formatActivityDate(date);
}

/** Axis label for a day/hour bucket key, or the raw label for other categories. */
export function formatActivityCategoryLabel(label: string): string {
  if (isActivityHourBucket(label) || /^\d{4}-\d{2}-\d{2}$/.test(label)) {
    return formatActivityDate(label);
  }
  return label;
}

/** Tooltip/aria label for a day/hour bucket key, or the raw label otherwise. */
export function formatActivityCategoryTooltipLabel(label: string): string {
  if (isActivityHourBucket(label) || /^\d{4}-\d{2}-\d{2}$/.test(label)) {
    return formatActivityTooltipDate(label);
  }
  return label;
}

/** Choose the first, middle, and last available chart labels. */
export function activityLabelIndexes(count: number): number[] {
  return [...new Set([0, Math.floor((count - 1) / 2), count - 1])].filter(
    (index) => index >= 0,
  );
}

/** Shared HTML axis label for chart ticks and bucket labels. */
export function ChartAxisHtmlLabel(props: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={cn(
        "font-sans tabular-nums text-2xs leading-none whitespace-nowrap text-dashboard-text-muted",
        props.className,
      )}
      style={props.style}
    >
      {props.children}
    </span>
  );
}

/** Bucket center in plot space. Each bucket is one unit wide. */
export function chartX(index: number): number {
  return index + 0.5;
}

/** Vertical plot-space position of a value: 0 is the top and 1 the bottom. */
export function chartY(value: number, maximum: number, minimum = 0): number {
  const span = maximum - minimum;
  return span > 0 ? (maximum - value) / span : 1;
}

/** Bar length as a percent of the plot height. */
export function chartPercent(value: number, maximum: number, minimum = 0) {
  const span = maximum - minimum;
  return span > 0 ? (Math.abs(value) / span) * 100 : 0;
}

/** Dashed average guide across all buckets, with its value label. */
export type ChartAverage = {
  color?: string;
  format(value: number): string;
  unit?: string;
  value: number;
};

/**
 * Lay out a bucketed chart with CSS only.
 * The plot has a fixed CSS height. Its SVG layer stretches to the plot box,
 * with one plot-space unit per bucket across and 0 to 1 down; strokes do not
 * stretch. Bucket columns, labels, and the average label are HTML, so text
 * keeps its CSS size at every width. Nothing in the chart is measured.
 */
export function ChartFrame(props: {
  "aria-label": string;
  average?: ChartAverage;
  /** Day or hour bucket keys, or category labels, in plot order. */
  buckets: readonly string[];
  /** Bucket columns from `ChartBucket`, one for each bucket. */
  children?: ReactNode;
  /** Plot height. Defaults to `h-40`. */
  className?: string;
  /** Message shown over the plot when the chart has no data. */
  empty?: ReactNode;
  formatLabel?(bucket: string): string;
  formatTick?(value: number): string;
  /** `edges` keeps the first and last labels inside the plot. */
  labelAlign?: "center" | "edges";
  /** SVG marks in plot space, such as lines and areas. */
  lines?: ReactNode;
  maximum: number;
  minimum?: number;
}) {
  const minimum = props.minimum ?? 0;
  const count = props.buckets.length;
  const formatTick =
    props.formatTick ?? ((value: number) => String(Math.round(value)));
  const formatLabel = props.formatLabel ?? formatActivityCategoryLabel;
  const ticks = [props.maximum, (props.maximum + minimum) / 2, minimum];
  const labelAlign = props.labelAlign ?? "edges";

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
      <div
        aria-hidden="true"
        className="-my-1.5 flex flex-col items-end justify-between"
      >
        {ticks.map((tick, index) => (
          <ChartAxisHtmlLabel key={index}>
            {formatTick(tick)}
          </ChartAxisHtmlLabel>
        ))}
      </div>
      <div className={cn("relative", props.className ?? "h-40")}>
        <svg
          aria-label={props["aria-label"]}
          className="absolute inset-0 size-full overflow-visible"
          preserveAspectRatio="none"
          role="img"
          viewBox={`0 0 ${Math.max(1, count)} 1`}
        >
          {[0, 0.5, 1].map((y) => (
            <line
              key={y}
              stroke="rgba(255,255,255,0.07)"
              strokeDasharray="3 5"
              vectorEffect="non-scaling-stroke"
              x1={0}
              x2={Math.max(1, count)}
              y1={y}
              y2={y}
            />
          ))}
          {props.lines}
          {props.average ? (
            <ChartAverageLine
              average={props.average}
              maximum={props.maximum}
              minimum={minimum}
              width={Math.max(1, count)}
            />
          ) : null}
        </svg>
        <div className="absolute inset-0 flex">{props.children}</div>
        {props.average ? (
          <ChartAverageLabel
            average={props.average}
            maximum={props.maximum}
            minimum={minimum}
          />
        ) : null}
        {props.empty ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center font-sans text-xs text-dashboard-text-muted">
            {props.empty}
          </div>
        ) : null}
      </div>
      <div />
      <div aria-hidden="true" className="relative mt-2 h-3">
        {activityLabelIndexes(count).map((index) => {
          const bucket = props.buckets[index]!;
          const position = (chartX(index) / count) * 100;
          const edge =
            labelAlign === "edges"
              ? index === 0
                ? "start"
                : index === count - 1
                  ? "end"
                  : "middle"
              : "middle";
          return (
            <ChartAxisHtmlLabel
              className={cn(
                "absolute top-0",
                edge === "middle" && "-translate-x-1/2",
              )}
              key={`${index}-${bucket}`}
              style={
                edge === "end"
                  ? { right: `${100 - position}%` }
                  : { left: `${position}%` }
              }
            >
              {formatLabel(bucket)}
            </ChartAxisHtmlLabel>
          );
        })}
      </div>
    </div>
  );
}

/** Formatted average label, or undefined when no average should show. */
function averageLabel(average: ChartAverage, maximum: number) {
  if (!(average.value > 0) || !(maximum > 0)) return undefined;
  const formatted = average.format(average.value).trim();
  // Flooring formatters can turn a real sub-1 mean into "0"; hide that case.
  if (!formatted || /^\$?0(?:\.0+)?(?:ms)?$/i.test(formatted)) return undefined;
  return `${formatted} / ${average.unit ?? "day"}`;
}

function ChartAverageLine(props: {
  average: ChartAverage;
  maximum: number;
  minimum: number;
  width: number;
}) {
  if (!averageLabel(props.average, props.maximum)) return null;
  const y = chartY(props.average.value, props.maximum, props.minimum);
  return (
    <line
      pointerEvents="none"
      stroke={props.average.color ?? "rgba(255,255,255,0.55)"}
      strokeDasharray="4 4"
      strokeOpacity={0.85}
      strokeWidth={1.25}
      vectorEffect="non-scaling-stroke"
      x1={0}
      x2={props.width}
      y1={y}
      y2={y}
    />
  );
}

/** Average value chip on a solid fill so bars and guides never cover it. */
function ChartAverageLabel(props: {
  average: ChartAverage;
  maximum: number;
  minimum: number;
}) {
  const label = averageLabel(props.average, props.maximum);
  if (!label) return null;
  const height =
    (1 - chartY(props.average.value, props.maximum, props.minimum)) * 100;
  // Keep the label inside the plot; put it below the guide near the top.
  const style: CSSProperties =
    height > 75
      ? { top: `calc(${100 - height}% + 4px)` }
      : { bottom: `calc(${height}% + 3px)` };
  return (
    <span
      aria-label={`average ${label}`}
      className="pointer-events-none absolute right-0 rounded-sm bg-dashboard-bg/90 px-1.5 py-0.5 font-sans tabular-nums text-2xs leading-none whitespace-nowrap text-dashboard-text-solid"
      style={style}
    >
      {label}
    </span>
  );
}

/**
 * One focusable bucket column with its tooltip.
 * Columns share the plot width equally, so marks inside line up with `chartX`.
 */
export function ChartBucket(props: {
  bucket: string;
  children?: ReactNode;
  className?: string;
  content: ReactNode;
  summary: string;
}) {
  return (
    <ActivityChartTooltip
      content={props.content}
      date={props.bucket}
      summary={props.summary}
      triggerClassName="h-full min-w-0 flex-1"
    >
      <button
        className={cn(
          "relative flex h-full w-full min-w-0 items-end justify-center focus-visible:outline-1 focus-visible:outline-dashboard-focus",
          props.className,
        )}
        type="button"
      >
        {props.children}
      </button>
    </ActivityChartTooltip>
  );
}

/**
 * Bar or stacked bar segment, sized as a percent of the plot height.
 * A non-zero value is at least 2px tall so it stays visible.
 */
export function ChartBar(props: {
  className?: string;
  /** CSS background, such as a color or gradient. */
  fill: string;
  percent: number;
}) {
  if (!(props.percent > 0)) return null;
  return (
    <span
      className={cn(
        "block min-h-0.5 shrink-0 rounded-t-[1px]",
        props.className,
      )}
      style={{ background: props.fill, height: `${props.percent}%` }}
    />
  );
}

/** Round point marker centered on a bucket at a percent of the plot height. */
export function ChartPoint(props: {
  className?: string;
  fill: string;
  percent: number;
}) {
  return (
    <span
      className={cn(
        "absolute left-1/2 block -translate-x-1/2 translate-y-1/2 rounded-full",
        props.className ?? "size-2",
      )}
      style={{ background: props.fill, bottom: `${props.percent}%` }}
    />
  );
}

/** Polyline points for one value per bucket, in plot space. */
export function chartLinePoints(
  values: readonly number[],
  maximum: number,
): string {
  return values
    .map((value, index) => `${chartX(index)},${chartY(value, maximum)}`)
    .join(" ");
}

/** Closed area path under one value per bucket, in plot space. */
export function chartAreaPath(
  values: readonly number[],
  maximum: number,
): string {
  if (values.length === 0) return "";
  return `M ${chartX(0)} 1 L ${values
    .map((value, index) => `${chartX(index)} ${chartY(value, maximum)}`)
    .join(" L ")} L ${chartX(values.length - 1)} 1 Z`;
}

/** Mean of chart bucket values; empty input is 0. */
export function activityChartAverage(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Render label and value rows inside an activity-chart tooltip. */
export function ActivityTooltipRows(props: {
  rows: ReadonlyArray<readonly [label: ReactNode, value: ReactNode]>;
}) {
  return (
    <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
      {props.rows.flatMap(([label, value], index) => [
        <span className="text-dashboard-text-muted" key={`${index}-label`}>
          {label}
        </span>,
        <span className="text-right text-dashboard-text" key={`${index}-value`}>
          {value}
        </span>,
      ])}
    </div>
  );
}

/**
 * Activity-chart tooltip that owns bucket date formatting.
 * Pass the UTC day/hour key as `date` so axes stay compact and tooltips always
 * include the local date for hour buckets. Other category labels show as they
 * are. Optional `summary` prefixes the trigger aria-label as
 * `"{date}: {summary}"`.
 */
export function ActivityChartTooltip(props: {
  children: ReactElement;
  content: ReactNode;
  date: string;
  summary?: string;
  triggerClassName?: string;
}) {
  const dateLabel = formatActivityCategoryTooltipLabel(props.date);
  const child = props.summary
    ? cloneElement(props.children, {
        "aria-label": `${dateLabel}: ${props.summary}`,
      } as never)
    : props.children;

  return (
    <Tooltip
      content={props.content}
      label={dateLabel}
      triggerClassName={props.triggerClassName}
    >
      {child}
    </Tooltip>
  );
}
