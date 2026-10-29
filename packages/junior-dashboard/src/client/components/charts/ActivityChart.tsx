import {
  cloneElement,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { ReferenceLine, usePlotArea, XAxis, YAxis } from "recharts";

import {
  Tooltip,
  TooltipContent,
  TooltipTitle,
  TooltipTrigger,
  tooltipContentVariants,
} from "../ui/tooltip";
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
function activityLabelIndexes(count: number): number[] {
  return [...new Set([0, Math.floor((count - 1) / 2), count - 1])].filter(
    (index) => index >= 0,
  );
}

/** Shared HTML axis label for non-SVG chart axes. */
export function ChartAxisHtmlLabel(props: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={cn(
        "font-sans tabular-nums text-2xs leading-none text-dashboard-text-muted",
        props.className,
      )}
      style={props.style}
    >
      {props.children}
    </span>
  );
}

/** Plot margins shared by dashboard Recharts charts. */
export const activityChartMargin = { bottom: 0, left: 4, right: 12, top: 12 };

/** Render the first, middle, and last bucket labels under a Recharts chart. */
export function ActivityChartXAxis(props: {
  /** Center every label, for categories that are not a time series. */
  centered?: boolean;
  dataKey?: string;
  formatLabel?(label: string): string;
  keys: readonly string[];
}) {
  const formatLabel = props.formatLabel ?? formatActivityCategoryLabel;
  const ticks = activityLabelIndexes(props.keys.length).map(
    (index) => props.keys[index]!,
  );
  const first = props.keys[0];
  const last = props.keys.at(-1);
  return (
    <XAxis
      axisLine={false}
      dataKey={props.dataKey ?? "date"}
      interval={0}
      tick={({ payload, x, y }) => {
        const value = String(payload.value);
        const anchor = props.centered
          ? "middle"
          : value === first
            ? "start"
            : value === last
              ? "end"
              : "middle";
        return (
          <text
            className="fill-dashboard-text-muted"
            dy="0.71em"
            textAnchor={anchor}
            x={x}
            y={y}
          >
            {formatLabel(value)}
          </text>
        );
      }}
      tickLine={false}
      tickMargin={8}
      ticks={ticks}
    />
  );
}

/** Render minimum, middle, and maximum guide values on a Recharts chart. */
export function ActivityChartYAxis(props: {
  format?(value: number): string;
  maximum: number;
  minimum?: number;
}) {
  const minimum = props.minimum ?? 0;
  const format = props.format ?? ((value: number) => String(Math.round(value)));
  return (
    <YAxis
      axisLine={false}
      domain={[minimum, props.maximum]}
      interval={0}
      tickFormatter={format}
      tickLine={false}
      tickMargin={8}
      ticks={[minimum, (minimum + props.maximum) / 2, props.maximum]}
      width="auto"
    />
  );
}

/** Mean of chart bucket values; empty input is 0. */
export function activityChartAverage(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Label for an average line, such as `3.2 / day`.
 * Returns nothing for a zero mean or when the formatter floors it to zero.
 */
export function activityChartAverageLabel(
  average: number,
  format: (value: number) => string,
  unit = "day",
): string | undefined {
  if (!(average > 0)) return undefined;
  const formatted = format(average).trim();
  if (!formatted || /^\$?0(?:\.0+)?(?:ms)?$/i.test(formatted)) return undefined;
  return `${formatted} / ${unit}`;
}

const AVERAGE_LABEL_FONT_PX = 12;

/**
 * Draw the average label on a solid chip at the right end of the line, so
 * series colors stay off the text. The chip flips below the line near the top.
 */
function ActivityChartAverageChip(props: {
  text: string;
  viewBox?: { width?: number; x?: number; y?: number };
}) {
  const plotArea = usePlotArea();
  const lineY = props.viewBox?.y ?? 0;
  const right = (props.viewBox?.x ?? 0) + (props.viewBox?.width ?? 0);
  const chipHeight = AVERAGE_LABEL_FONT_PX + 6;
  // Width estimate for tabular digits at the label size.
  const chipWidth =
    Math.max(52, props.text.length * AVERAGE_LABEL_FONT_PX * 0.62) + 10;
  const above = lineY - (plotArea?.y ?? 0) > chipHeight + 4;
  const chipY = above ? lineY - chipHeight - 3 : lineY + 4;
  return (
    <g pointerEvents="none">
      <rect
        fill="var(--color-dashboard-bg-elevated)"
        fillOpacity={0.92}
        height={chipHeight}
        rx={3}
        width={chipWidth}
        x={right - chipWidth}
        y={chipY}
      />
      <text
        className="fill-dashboard-text-solid font-sans tabular-nums"
        dominantBaseline="central"
        textAnchor="middle"
        x={right - chipWidth / 2}
        y={chipY + chipHeight / 2}
      >
        {props.text}
      </text>
    </g>
  );
}

/**
 * Opt-in horizontal average across the plotted buckets.
 * Renders a dashed guide plus a compact "value / day" label on the right.
 */
export function ActivityChartAverageLine(props: {
  average: number;
  format(value: number): string;
  stroke?: string;
  unit?: string;
}) {
  const label = activityChartAverageLabel(
    props.average,
    props.format,
    props.unit,
  );
  if (!label) return null;
  return (
    <ReferenceLine
      aria-label={`average ${label}`}
      ifOverflow="extendDomain"
      label={<ActivityChartAverageChip text={label} />}
      stroke={props.stroke ?? "var(--color-dashboard-text-faint)"}
      strokeDasharray="4 4"
      strokeOpacity={0.85}
      strokeWidth={1.25}
      y={props.average}
    />
  );
}

type TooltipRows = ReadonlyArray<readonly [label: ReactNode, value: ReactNode]>;

/**
 * Recharts tooltip body for one activity bucket. It titles the bucket with
 * `formatLabel`, or by default `formatActivityCategoryTooltipLabel`, and lists
 * `rows` for the hovered datum.
 * Pass it as `content` of `ChartTooltip`; Recharts injects the other props.
 */
export function ActivityChartTooltipContent<Datum>(props: {
  active?: boolean;
  formatLabel?(label: string): string;
  label?: unknown;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  rows(datum: Datum): TooltipRows;
}) {
  const datum = props.payload?.[0]?.payload as Datum | undefined;
  if (!props.active || datum === undefined) return null;
  const formatLabel = props.formatLabel ?? formatActivityCategoryTooltipLabel;
  return (
    <div className={tooltipContentVariants()} role="status">
      <TooltipTitle>{formatLabel(String(props.label))}</TooltipTitle>
      <ActivityTooltipRows rows={props.rows(datum)} />
    </div>
  );
}

/** Render label and value rows inside an activity-chart tooltip. */
export function ActivityTooltipRows(props: { rows: TooltipRows }) {
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
 * include the local date for hour buckets. Optional `summary` prefixes the
 * trigger aria-label as `"{date}: {summary}"`.
 */
export function ActivityChartTooltip(props: {
  children: ReactElement;
  content: ReactNode;
  date: string;
  summary?: string;
}) {
  const dateLabel = formatActivityTooltipDate(props.date);
  const child = props.summary
    ? cloneElement(props.children, {
        "aria-label": `${dateLabel}: ${props.summary}`,
      } as never)
    : props.children;

  return (
    <Tooltip>
      <TooltipTrigger render={child} />
      <TooltipContent>
        <TooltipTitle>{dateLabel}</TooltipTitle>
        {props.content}
      </TooltipContent>
    </Tooltip>
  );
}
