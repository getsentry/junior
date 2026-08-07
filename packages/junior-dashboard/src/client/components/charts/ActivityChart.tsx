import type { ReactNode } from "react";

/** Shared SVG dimensions and derived plot bounds for activity charts. */
export type ActivityChartLayout = {
  bottom: number;
  height: number;
  left: number;
  plotHeight: number;
  plotWidth: number;
  right: number;
  top: number;
  width: number;
};

/** Create the shared plot dimensions used by dashboard activity charts. */
export function createActivityChartLayout(height: number): ActivityChartLayout {
  const width = 960;
  const left = 56;
  const right = 18;
  const top = 24;
  const bottom = 36;
  return {
    bottom,
    height,
    left,
    plotHeight: height - top - bottom,
    plotWidth: width - left - right,
    right,
    top,
    width,
  };
}

/** Format an activity date without applying the browser's local time zone. */
export function formatActivityDate(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Choose the first, middle, and last available chart labels. */
export function activityLabelIndexes(count: number): number[] {
  return [...new Set([0, Math.floor((count - 1) / 2), count - 1])].filter(
    (index) => index >= 0,
  );
}

/** Render the shared horizontal guide lines and values for activity charts. */
export function ActivityChartGrid(props: {
  layout: ActivityChartLayout;
  maximum: number;
}) {
  return [0, 0.5, 1].map((ratio) => {
    const yPosition = props.layout.top + ratio * props.layout.plotHeight;
    return (
      <g key={ratio}>
        <line
          stroke="rgba(255,255,255,0.07)"
          strokeDasharray="3 5"
          x1={props.layout.left}
          x2={props.layout.width - props.layout.right}
          y1={yPosition}
          y2={yPosition}
        />
        <text
          fill="rgba(255,255,255,0.5)"
          fontFamily="ui-monospace, monospace"
          fontSize="13"
          textAnchor="end"
          x={props.layout.left - 8}
          y={yPosition + 3}
        >
          {Math.round(props.maximum * (1 - ratio))}
        </text>
      </g>
    );
  });
}

/** Render the shared first, middle, and last date labels for activity charts. */
export function ActivityChartDateLabels(props: {
  dates: readonly string[];
  layout: ActivityChartLayout;
  xPosition(index: number): number;
}) {
  return activityLabelIndexes(props.dates.length).map((index) => {
    const date = props.dates[index];
    if (!date) return null;
    return (
      <text
        fill="rgba(255,255,255,0.5)"
        fontFamily="ui-monospace, monospace"
        fontSize="13"
        key={date}
        textAnchor={
          index === 0
            ? "start"
            : index === props.dates.length - 1
              ? "end"
              : "middle"
        }
        x={props.xPosition(index)}
        y={props.layout.height - 8}
      >
        {formatActivityDate(date)}
      </text>
    );
  });
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
