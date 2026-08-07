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
                    "font-mono font-semibold text-dashboard-text",
                  line.valueStyle === "heading" &&
                    index > 0 &&
                    "mt-1 border-t border-white/10 pt-2",
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
                <span className="ml-2 inline-flex items-center gap-1.5 font-sans text-[0.7rem] font-normal tracking-wide text-dashboard-text-muted">
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
  tooltipColumns?: MetricTooltipLine[][];
  tooltipPlacement?: "above" | "below";
}) {
  const tooltip = props.tooltip?.filter((line) => line.value.trim());
  const tooltipColumns = props.tooltipColumns
    ?.map((column) => column.filter((line) => line.value.trim()))
    .filter((column) => column.length);
  const wide = Boolean(tooltipColumns?.length);

  if (!tooltip?.length && !tooltipColumns?.length) {
    return <span className={props.className}>{props.children}</span>;
  }

  return (
    <Tooltip
      align={props.align}
      className={cn(
        "w-[calc(100vw-2rem)] rounded-lg border border-white/15 bg-[#050505] px-3 py-2 text-left text-xs font-normal leading-relaxed text-dashboard-text-muted shadow-xl shadow-black/35",
        wide ? "max-w-[32.5rem]" : "max-w-80",
      )}
      content={
        tooltipColumns?.length ? (
          <span className="grid max-h-72 grid-cols-1 items-start gap-4 overflow-y-auto sm:grid-cols-2 sm:gap-6">
            {tooltipColumns.map((column, index) => (
              <TooltipLines key={index} lines={column} />
            ))}
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
          "inline-flex border-b border-dotted border-white/20 outline-none transition-colors hover:border-white/45 focus-visible:border-white/45",
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
