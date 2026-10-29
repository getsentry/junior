import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "@dashboard/lib/utils";

const INITIAL_DIMENSION = { width: 320, height: 200 } as const;

type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    color?: string;
  }
>;

/**
 * Size a Recharts chart to its box and expose each config color as
 * `var(--color-<key>)` inside it.
 */
function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<
    typeof RechartsPrimitive.ResponsiveContainer
  >["children"];
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`;

  return (
    <div
      data-slot="chart"
      data-chart={chartId}
      className={cn(
        "flex aspect-video justify-center font-sans text-2xs tabular-nums [&_.recharts-cartesian-axis-tick-value]:fill-dashboard-text-muted [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-dashboard-border-subtle [&_.recharts-curve.recharts-tooltip-cursor]:stroke-dashboard-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-dashboard-fill-soft [&_.recharts-reference-line_[stroke='#ccc']]:stroke-dashboard-border [&_.recharts-surface]:outline-hidden [&_.recharts-surface]:focus-visible:outline-2 [&_.recharts-surface]:focus-visible:outline-dashboard-focus",
        className,
      )}
      {...props}
    >
      <ChartStyle id={chartId} config={config} />
      <RechartsPrimitive.ResponsiveContainer
        initialDimension={INITIAL_DIMENSION}
      >
        {children}
      </RechartsPrimitive.ResponsiveContainer>
    </div>
  );
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colors = Object.entries(config).flatMap(([key, { color }]) =>
    color ? [`  --color-${key}: ${color};`] : [],
  );

  if (!colors.length) {
    return null;
  }

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `[data-chart=${id}] {\n${colors.join("\n")}\n}`,
      }}
    />
  );
};

const ChartTooltip = RechartsPrimitive.Tooltip;

export { ChartContainer, ChartTooltip };
