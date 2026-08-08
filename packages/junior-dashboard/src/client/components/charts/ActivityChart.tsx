import {
  createContext,
  type CSSProperties,
  type ReactNode,
  type SVGProps,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "../../styles";

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

type LayoutOptions = {
  bottom?: number;
  left?: number;
  right?: number;
  top?: number;
  width?: number;
};

/** Create the shared plot dimensions used by dashboard activity charts. */
export function createActivityChartLayout(
  height: number,
  options?: LayoutOptions,
): ActivityChartLayout {
  const width = options?.width ?? 960;
  const left = options?.left ?? 56;
  const right = options?.right ?? 18;
  const top = options?.top ?? 24;
  const bottom = options?.bottom ?? 36;
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

const chartAxisFontSizePx = 12;
const ChartSvgScaleContext = createContext(1);

/** Shared visual style for SVG chart axis labels. */
export const chartAxisLabelClassName =
  "fill-white/50 font-mono leading-none text-dashboard-text-muted";

type ChartAxisLabelProps = Omit<
  SVGProps<SVGTextElement>,
  "children" | "className" | "fill" | "fontFamily" | "fontSize"
> & {
  children: ReactNode;
};

/** Render an SVG axis label at the shared on-screen size. */
export function ChartAxisLabel(props: ChartAxisLabelProps) {
  const { children, ...textProps } = props;
  const scale = useContext(ChartSvgScaleContext);
  return (
    <text
      className={chartAxisLabelClassName}
      fontSize={chartAxisFontSizePx / scale}
      {...textProps}
    >
      {children}
    </text>
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
        "font-mono text-2xs leading-none text-dashboard-text-muted",
        props.className,
      )}
      style={props.style}
    >
      {props.children}
    </span>
  );
}

/**
 * Render the shared SVG chart shell and provide its live screen scale to labels.
 * SVG text uses user units, so labels invert this scale to remain 12px on screen.
 */
export function ChartSvg(props: {
  "aria-label": string;
  children: ReactNode;
  className?: string;
  layout: ActivityChartLayout;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const updateScale = () => {
      const matrix = svg.getScreenCTM();
      const nextScale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
      setScale(nextScale > 0 ? nextScale : 1);
    };
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  return (
    <ChartSvgScaleContext value={scale}>
      <svg
        aria-label={props["aria-label"]}
        className={cn("block h-auto w-full", props.className)}
        ref={svgRef}
        role="img"
        viewBox={`0 0 ${props.layout.width} ${props.layout.height}`}
      >
        {props.children}
      </svg>
    </ChartSvgScaleContext>
  );
}

/** Render the shared horizontal guide lines and values for activity charts. */
export function ActivityChartGrid(props: {
  format?(value: number): string;
  layout: ActivityChartLayout;
  maximum: number;
}) {
  const format = props.format ?? ((value: number) => String(Math.round(value)));
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
        <ChartAxisLabel
          textAnchor="end"
          x={props.layout.left - 8}
          y={yPosition + 3}
        >
          {format(props.maximum * (1 - ratio))}
        </ChartAxisLabel>
      </g>
    );
  });
}

/** Render the shared first, middle, and last date labels for activity charts. */
export function ActivityChartDateLabels(props: {
  dates: readonly string[];
  formatDate?(date: string): string;
  layout: ActivityChartLayout;
  xPosition(index: number): number;
}) {
  const formatDate = props.formatDate ?? formatActivityDate;
  return activityLabelIndexes(props.dates.length).map((index) => {
    const date = props.dates[index];
    if (!date) return null;
    return (
      <ChartAxisLabel
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
        {formatDate(date)}
      </ChartAxisLabel>
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
