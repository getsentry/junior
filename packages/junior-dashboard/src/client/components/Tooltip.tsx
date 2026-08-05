import * as HoverCard from "@radix-ui/react-hover-card";
import {
  type ReactElement,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";

import { cn } from "../styles";

type TooltipProps = {
  align?: "center" | "left" | "right";
  children: ReactElement;
  className?: string;
  content: ReactNode;
  label?: ReactNode;
  placement?: "above" | "below";
};

const VIEWPORT_GAP = 8;
const ANCHOR_GAP = 10;
const CLOSE_DELAY_MS = 150;

/** Show selectable dashboard details beside an element. */
export function Tooltip({
  align = "center",
  children,
  className,
  content,
  label,
  placement = "above",
}: TooltipProps) {
  const tooltipId = useId();
  const touchStartedOpenRef = useRef<boolean | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <HoverCard.Root
      closeDelay={CLOSE_DELAY_MS}
      onOpenChange={setOpen}
      open={open}
      openDelay={0}
    >
      <HoverCard.Trigger
        aria-describedby={open ? tooltipId : undefined}
        asChild
        onPointerCancel={() => {
          touchStartedOpenRef.current = null;
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") {
            touchStartedOpenRef.current = open;
          }
        }}
        onPointerUp={(event) => {
          if (
            event.pointerType !== "touch" ||
            touchStartedOpenRef.current === null
          ) {
            return;
          }
          setOpen(!touchStartedOpenRef.current);
          touchStartedOpenRef.current = null;
        }}
      >
        {children}
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          align={
            align === "left" ? "start" : align === "right" ? "end" : "center"
          }
          className={cn(
            "z-50 select-text outline-none",
            className ??
              "min-w-36 max-w-64 rounded-md border border-white/15 bg-dashboard-surface-raised px-3 py-2 font-mono text-[0.68rem] leading-relaxed text-dashboard-text-muted shadow-2xl shadow-black/70",
          )}
          collisionPadding={VIEWPORT_GAP}
          hideWhenDetached
          id={tooltipId}
          role="tooltip"
          side={placement === "above" ? "top" : "bottom"}
          sideOffset={ANCHOR_GAP}
        >
          {label ? (
            <div className="mb-1 font-semibold uppercase tracking-[0.1em] text-dashboard-text-muted">
              {label}
            </div>
          ) : null}
          {content}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
