import {
  cloneElement,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../styles";

type TooltipProps = {
  align?: "center" | "left" | "right";
  children: ReactElement;
  className?: string;
  content: ReactNode;
  label?: ReactNode;
  placement?: "above" | "below";
};

type Position = {
  left: number;
  top: number;
};

const VIEWPORT_GAP = 8;
const ANCHOR_GAP = 10;

/** Show dashboard details beside an element while keeping the surface on-screen. */
export function Tooltip({
  align = "center",
  children,
  className,
  content,
  label,
  placement = "above",
}: TooltipProps) {
  const anchorRef = useRef<Element | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const tooltip = tooltipRef.current;
    if (!anchor || !tooltip) return;

    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const preferredLeft =
      align === "left"
        ? anchorRect.left
        : align === "right"
          ? anchorRect.right - tooltipRect.width
          : anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;
    const left = Math.max(
      VIEWPORT_GAP,
      Math.min(
        window.innerWidth - tooltipRect.width - VIEWPORT_GAP,
        preferredLeft,
      ),
    );
    const above = anchorRect.top - tooltipRect.height - ANCHOR_GAP;
    const below = anchorRect.bottom + ANCHOR_GAP;
    const fitsAbove = above >= VIEWPORT_GAP;
    const fitsBelow =
      below + tooltipRect.height <= window.innerHeight - VIEWPORT_GAP;
    const preferredTop =
      placement === "above"
        ? fitsAbove || !fitsBelow
          ? above
          : below
        : fitsBelow || !fitsAbove
          ? below
          : above;
    const top = Math.max(
      VIEWPORT_GAP,
      Math.min(
        window.innerHeight - tooltipRect.height - VIEWPORT_GAP,
        preferredTop,
      ),
    );
    setPosition({ left, top });
  }, [align, placement]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  const child = children as ReactElement<Record<string, unknown>>;
  const childProps = child.props;
  const trigger = cloneElement(child, {
    "aria-describedby": open ? tooltipId : undefined,
    onBlur(event: FocusEvent<Element>) {
      (
        childProps.onBlur as ((event: FocusEvent<Element>) => void) | undefined
      )?.(event);
      setOpen(false);
    },
    onFocus(event: FocusEvent<Element>) {
      (
        childProps.onFocus as ((event: FocusEvent<Element>) => void) | undefined
      )?.(event);
      setOpen(true);
    },
    onPointerEnter(event: PointerEvent<Element>) {
      (
        childProps.onPointerEnter as
          | ((event: PointerEvent<Element>) => void)
          | undefined
      )?.(event);
      setOpen(true);
    },
    onPointerLeave(event: PointerEvent<Element>) {
      (
        childProps.onPointerLeave as
          | ((event: PointerEvent<Element>) => void)
          | undefined
      )?.(event);
      setOpen(false);
    },
    ref(node: Element | null) {
      anchorRef.current = node;
    },
  });

  return (
    <>
      {trigger}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className={cn(
                "pointer-events-none fixed z-50",
                className ??
                  "min-w-36 max-w-64 rounded-md border border-white/15 bg-dashboard-surface-raised px-3 py-2 font-mono text-[0.68rem] leading-relaxed text-dashboard-text-muted shadow-2xl shadow-black/70",
              )}
              id={tooltipId}
              ref={tooltipRef}
              role="tooltip"
              style={{
                left: position?.left ?? 0,
                opacity: position ? 1 : 0,
                top: position?.top ?? 0,
              }}
            >
              {label ? (
                <div className="mb-1 font-semibold uppercase tracking-[0.1em] text-dashboard-text-muted">
                  {label}
                </div>
              ) : null}
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
