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
): TooltipPosition {
  const margin = 16;
  const viewportWidth = window.innerWidth;
  const width = Math.min(320, Math.max(256, viewportWidth - margin * 2));
  const rect = trigger.getBoundingClientRect();
  const preferredLeft = align === "right" ? rect.right - width : rect.left;
  return {
    left: Math.round(
      clamp(preferredLeft, margin, viewportWidth - width - margin),
    ),
    top: Math.round(rect.bottom + 8),
    width,
  };
}

/** Render compact metadata text with an optional styled hover/focus tooltip. */
export function MetricValue(props: {
  align?: "left" | "right";
  children: ReactNode;
  className?: string;
  tooltip?: MetricTooltipLine[];
}) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const tooltip = props.tooltip?.filter((line) => line.value.trim());
  if (!tooltip?.length) {
    return <span className={props.className}>{props.children}</span>;
  }

  const showTooltip = () => {
    if (!triggerRef.current) return;
    setPosition(tooltipPosition(triggerRef.current, props.align));
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
          className="pointer-events-none fixed z-30 rounded-lg border border-white/15 bg-[#050505] px-3 py-2 text-left text-[0.76rem] font-normal leading-relaxed text-[#b8b8b8] shadow-xl shadow-black/35"
          id={tooltipId}
          role="tooltip"
          style={tooltipStyle}
        >
          <span className="grid max-h-72 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 overflow-y-auto">
            {tooltip.map((line, index) => (
              <span
                className={
                  line.label
                    ? "contents"
                    : "col-span-2 block min-w-0 break-words text-[#d6d6d6]"
                }
                key={`${index}-${line.label ?? ""}-${line.value}`}
              >
                {line.label ? (
                  <span
                    className={cn(
                      "min-w-0 break-words font-medium text-[#888]",
                      line.labelStyle === "code" &&
                        "break-all font-mono text-[0.74rem] text-[#d6d6d6]",
                    )}
                  >
                    {line.label}
                  </span>
                ) : null}
                {line.label ? (
                  <span className="whitespace-nowrap text-right text-[#d6d6d6]">
                    {line.value}
                  </span>
                ) : (
                  line.value
                )}
              </span>
            ))}
          </span>
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
          {index > 0 ? <span className="text-[#666]">·</span> : null}
          <span className="min-w-0">{item.content}</span>
        </span>
      ))}
    </div>
  );
}
