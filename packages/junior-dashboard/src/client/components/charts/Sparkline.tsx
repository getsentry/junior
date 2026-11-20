import { cn } from "../../styles";
import { ChartLegend } from "./ChartLegend";

// The SVG draws in its own units and scales to the width of its box.
const WIDTH = 100;
const HEIGHT = 24;

// One color for each of up to five series, in series order.
const SERIES_COLORS = [
  "var(--color-violet-400)",
  "var(--color-cyan-300)",
  "var(--color-emerald-300)",
  "var(--color-amber-300)",
  "var(--color-rose-400)",
];

type SparklineSeries = { label?: string; points: readonly number[] };

function x(index: number, count: number): number {
  return count > 1 ? (index * WIDTH) / (count - 1) : 0;
}

/**
 * Draw a small chart of one or more series, oldest first, under a label. It
 * shows the shape only: the highest value sits at the top. Bars stack, so
 * the top of a column is the sum of its series. A legend names the series
 * when there is more than one.
 */
export function Sparkline({
  display = "area",
  label,
  series,
  tall = false,
}: {
  display?: "area" | "bar" | "line";
  label: string;
  series: readonly SparklineSeries[];
  tall?: boolean;
}) {
  const single = series.length === 1;
  const color = (index: number) =>
    single ? "currentColor" : SERIES_COLORS[index % SERIES_COLORS.length]!;
  const columns = Math.max(...series.map((item) => item.points.length));
  const totals = Array.from({ length: columns }, (_, column) =>
    series.reduce(
      (sum, item) => sum + Math.max(item.points[column] ?? 0, 0),
      0,
    ),
  );
  const values = series.flatMap((item) => item.points);
  const top = Math.max(display === "bar" ? Math.max(...totals) : 0, ...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom;
  const y = (value: number) =>
    span > 0 ? HEIGHT - ((value - bottom) / span) * HEIGHT : HEIGHT;
  const zero = y(0);

  let marks;
  if (display === "bar") {
    const width = WIDTH / columns;
    const stacked = Array.from({ length: columns }, () => 0);
    marks = series.map((item, index) => (
      <g fill={color(index)} key={index}>
        {item.points.map((value, column) => {
          const base = stacked[column]!;
          const end = base + Math.max(value, 0);
          stacked[column] = end;
          return (
            <rect
              height={y(base) - y(end)}
              key={column}
              width={width * 0.8}
              x={column * width + width * 0.1}
              y={y(end)}
            />
          );
        })}
      </g>
    ));
  } else {
    marks = series.map((item, index) => {
      const line = item.points
        .map(
          (value, column) =>
            `${x(column, item.points.length).toFixed(2)},${y(value).toFixed(2)}`,
        )
        .join(" ");
      return (
        <g key={index} stroke={color(index)}>
          {display === "area" && (
            <polygon
              fill={color(index)}
              fillOpacity={single ? 0.15 : 0.08}
              points={`0,${zero} ${line} ${WIDTH},${zero}`}
              stroke="none"
            />
          )}
          <polyline
            fill="none"
            points={line}
            strokeLinejoin="round"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      );
    });
  }

  return (
    <figure className="m-0 grid gap-1">
      <figcaption className="break-words text-xs text-dashboard-text-muted">
        {label}
      </figcaption>
      <svg
        aria-hidden="true"
        className={cn(
          "w-full overflow-visible text-dashboard-accent",
          tall ? "h-24" : "h-8",
        )}
        preserveAspectRatio="none"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        {marks}
      </svg>
      {!single && (
        <ChartLegend
          ariaLabel="Series"
          inline
          items={series.map((item, index) => ({
            color: color(index),
            key: String(index),
            label: item.label ?? `Series ${index + 1}`,
          }))}
        />
      )}
    </figure>
  );
}
