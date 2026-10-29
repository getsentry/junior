import type { ReactNode } from "react";

import { cn } from "../styles";

/**
 * Own the conversation chat frame: one scroll region above one dock.
 *
 * Pages pass `header`, `scroll`, and `dock`. Do not invent footer padding, safe-area,
 * or shell height math outside this component and `ComposerDock`.
 */
export function ChatLayout(props: {
  className?: string;
  dock?: ReactNode;
  /** Keep conversation chrome outside the scrolling content. */
  header?: ReactNode;
  /** When true, keep a taller minimum scroll region for long transcripts. */
  scrollMinTall?: boolean;
  scroll: ReactNode;
  scrollAriaLabel?: string;
  scrollClassName?: string;
}) {
  return (
    <div
      className={cn(
        "grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_minmax(0,auto)]",
        props.scrollMinTall &&
          "grid-rows-[auto_minmax(7rem,1fr)_minmax(0,auto)]",
        props.className,
      )}
    >
      <div className="min-w-0">{props.header}</div>
      <div
        aria-label={props.scrollAriaLabel}
        className={cn(
          "min-h-0 overflow-y-auto overscroll-contain outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-dashboard-focus",
          props.scrollClassName,
        )}
        data-chat-scroll=""
        tabIndex={props.scrollAriaLabel ? 0 : undefined}
      >
        {props.scroll}
      </div>
      {props.dock}
    </div>
  );
}
