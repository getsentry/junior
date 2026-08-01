import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { cn } from "../styles";

export type MetricTooltipLine = {
  label?: string;
  labelStyle?: "code";
  value: string;
  valueStyle?: "heading";
};

export type MetricListItem = {
  content: ReactNode;
  key: string;
};

type TooltipPosition = {
  left: number;
  top: number;
  width: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function tooltipPosition(
  trigger: HTMLElement,
  align: "left" | "right" | undefined,
  topAligned: boolean,
  wide: boolean,
): TooltipPosition {
  const margin = 16;
  const viewportWidth = window.innerWidth;
  const maxWidth = wide ? 520 : 320;
  const width = Math.min(maxWidth, Math.max(256, viewportWidth - margin * 2));
  const rect = trigger.getBoundingClientRect();
  const preferredLeft = align === "right" ? rect.right - width : rect.left;
  return {
    left: Math.round(
      clamp(preferredLeft, margin, viewportWidth - width - margin),
    ),
    top: Math.round(topAligned ? rect.top : rect.bottom + 8),
    width,
  };
}

function TooltipLines(props: { lines: MetricTooltipLine[] }) {
  return (
    <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5">
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
          key={`${index}-${line.label ?? ""}-${line.value}`}
        >
          {line.label ? (
            <span
              className={cn(
                "min-w-0 break-words font-medium text-dashboard-text-muted",
                line.labelStyle === "code" &&
                  "break-all font-mono text-[0.74rem] text-dashboard-text",
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
            line.value
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
  tooltipTopAligned?: boolean;
}) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const tooltip = props.tooltip?.filter((line) => line.value.trim());
  const tooltipColumns = props.tooltipColumns
    ?.map((column) => column.filter((line) => line.value.trim()))
    .filter((column) => column.length);
  if (!tooltip?.length && !tooltipColumns?.length) {
    return <span className={props.className}>{props.children}</span>;
  }

  const showTooltip = () => {
    if (!triggerRef.current) return;
    setPosition(
      tooltipPosition(
        triggerRef.current,
        props.align,
        Boolean(props.tooltipTopAligned),
        Boolean(tooltipColumns?.length),
      ),
    );
  };
  const hideTooltip = () => setPosition(null);
  const tooltipStyle: CSSProperties | undefined = position
    ? {
        left: position.left,
        top: position.top,
        width: position.width,
      }
    : undefined;

  return (
    <span className={cn("relative inline-flex", props.className)}>
      <span
        aria-describedby={position ? tooltipId : undefined}
        className="border-b border-dotted border-white/20 outline-none transition-colors hover:border-white/45 focus-visible:border-white/45"
        onBlur={hideTooltip}
        onFocus={showTooltip}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        ref={triggerRef}
        tabIndex={0}
      >
        {props.children}
      </span>
      {position ? (
        <span
          className="pointer-events-none fixed z-30 rounded-lg border border-white/15 bg-[#050505] px-3 py-2 text-left text-[0.76rem] font-normal leading-relaxed text-dashboard-text-muted shadow-xl shadow-black/35"
          id={tooltipId}
          role="tooltip"
          style={tooltipStyle}
        >
          {tooltipColumns?.length ? (
            <span className="grid max-h-72 grid-cols-1 gap-4 overflow-y-auto sm:grid-cols-2 sm:gap-6">
              {tooltipColumns.map((column, index) => (
                <TooltipLines key={index} lines={column} />
              ))}
            </span>
          ) : tooltip ? (
            <span className="block max-h-72 overflow-y-auto">
              <TooltipLines lines={tooltip} />
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
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
