import type { ReactNode } from "react";

import { cn } from "../styles";
import { ShimmerText } from "./ShimmerText";
import { Tooltip } from "./Tooltip";

export type MetricTooltipLine = {
  label?: string;
  labelStyle?: "code";
  live?: boolean;
  value: string;
  valueStyle?: "heading";
};

export type MetricListItem = {
  content: ReactNode;
  key: string;
};

function TooltipLines(props: { lines: MetricTooltipLine[] }) {
  return (
    <span className="grid min-w-0 self-start grid-cols-[minmax(0,1fr)_auto] content-start gap-x-3 gap-y-1.5">
      {props.lines.map((line, index) => (
        <span
          className={
            line.label
              ? "contents"
              : cn(
                  "col-span-2 block min-w-0 break-words text-dashboard-text",
                  line.valueStyle === "heading" &&
                    "font-sans tabular-nums font-semibold text-dashboard-text",
                  line.valueStyle === "heading" &&
                    index > 0 &&
                    "mt-1 border-t border-dashboard-border-strong pt-2",
                )
          }
          key={`${index}-${line.label ?? ""}-${line.value}-${line.live ? "live" : ""}`}
        >
          {line.label ? (
            <span
              className={cn(
                "min-w-0 break-words font-medium text-dashboard-text-muted",
                line.labelStyle === "code" &&
                  "break-all font-mono text-xs text-dashboard-text",
              )}
            >
              {line.label}
            </span>
          ) : null}
          {line.label ? (
            <span className="whitespace-nowrap text-right text-dashboard-text">
              {line.value}
            </span>
          ) : (
            <>
              {line.value}
              {line.live ? (
                <span className="ml-2 inline-flex items-center gap-1.5 font-sans text-xs font-normal tracking-wide text-dashboard-text-muted">
                  <span aria-hidden="true">·</span>
                  <ShimmerText active>in progress</ShimmerText>
                </span>
              ) : null}
            </>
          )}
        </span>
      ))}
    </span>
  );
}

/** Render compact metadata text with an optional styled hover/focus tooltip. */
export function MetricValue(props: {
  align?: "left" | "right";
  children: ReactNode;
  className?: string;
  tooltip?: MetricTooltipLine[];
  /** Custom tooltip content, such as a usage summary, instead of lines. */
  tooltipCard?: ReactNode;
  tooltipPlacement?: "above" | "below";
}) {
  const tooltip = props.tooltip?.filter((line) => line.value.trim());

  if (!props.tooltipCard && !tooltip?.length) {
    return <span className={props.className}>{props.children}</span>;
  }

  return (
    <Tooltip
      align={props.align}
      className={cn(
        "w-[calc(100vw-2rem)] max-w-80 rounded-lg border border-dashboard-border-emphasis bg-dashboard-bg text-left text-xs font-normal text-dashboard-text-muted shadow-xl shadow-black/35",
        props.tooltipCard ? "p-3 leading-snug" : "px-3 py-2 leading-relaxed",
      )}
      content={
        props.tooltipCard ? (
          <span className="block max-h-[min(30rem,var(--radix-hover-card-content-available-height,30rem))] overflow-y-auto">
            {props.tooltipCard}
          </span>
        ) : tooltip ? (
          <span className="block max-h-72 overflow-y-auto">
            <TooltipLines lines={tooltip} />
          </span>
        ) : null
      }
      placement={props.tooltipPlacement ?? "below"}
    >
      <span
        className={cn(
          "inline-flex border-b border-dotted border-dashboard-border-interactive outline-none transition-colors hover:border-dashboard-border-heavy focus-visible:border-dashboard-border-heavy",
          props.className,
        )}
        tabIndex={0}
      >
        {props.children}
      </span>
    </Tooltip>
  );
}

/** Render inline metadata with consistent dot spacing across dashboard headers. */
export function MetricList(props: {
  className?: string;
  items: MetricListItem[];
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-1.5 gap-y-1",
        props.className,
      )}
    >
      {props.items.map((item, index) => (
        <span
          className="inline-flex min-w-0 items-center gap-x-1.5"
          key={item.key}
        >
          {index > 0 ? (
            <span className="text-dashboard-text-muted">·</span>
          ) : null}
          <span className="min-w-0">{item.content}</span>
        </span>
      ))}
    </div>
  );
}
