// The SVG draws in its own units and scales to the width of its box.
const WIDTH = 100;
const HEIGHT = 24;

/**
 * Draw a small line of nonnegative values, oldest first, under a label. It
 * shows the shape only: the peak sits at the top and zero at the bottom.
 */
export function Sparkline({
  label,
  points,
}: {
  label: string;
  points: readonly number[];
}) {
  const peak = Math.max(...points);
  const step = WIDTH / (points.length - 1);
  const line = points
    .map((value, index) => {
      const y = peak > 0 ? HEIGHT - (value / peak) * HEIGHT : HEIGHT;
      return `${(index * step).toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <figure className="m-0 grid gap-1">
      <figcaption className="text-xs text-dashboard-text-muted">
        {label}
      </figcaption>
      <svg
        aria-hidden="true"
        className="h-8 w-full overflow-visible text-dashboard-accent"
        preserveAspectRatio="none"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        <polygon
          fill="currentColor"
          fillOpacity={0.15}
          points={`0,${HEIGHT} ${line} ${WIDTH},${HEIGHT}`}
        />
        <polyline
          fill="none"
          points={line}
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </figure>
  );
}
