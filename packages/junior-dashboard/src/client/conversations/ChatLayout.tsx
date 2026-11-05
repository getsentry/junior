import type { ReactNode, Ref } from "react";

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
  /**
   * Show over the scroll region without scrolling with it. It sits in a
   * `chat` container, so it can show only when the region is wide enough.
   */
  overlay?: ReactNode;
  /** When true, keep a taller minimum scroll region for long transcripts. */
  scrollMinTall?: boolean;
  scroll: ReactNode;
  scrollAriaLabel?: string;
  scrollClassName?: string;
  scrollRef?: Ref<HTMLDivElement>;
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
      <div className="@container/chat relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]">
        <div
          aria-label={props.scrollAriaLabel}
          className={cn(
            "min-h-0 overflow-y-auto overscroll-contain outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-dashboard-focus",
            props.scrollClassName,
          )}
          data-chat-scroll=""
          ref={props.scrollRef}
          tabIndex={props.scrollAriaLabel ? 0 : undefined}
        >
          {props.scroll}
        </div>
        {props.overlay}
      </div>
      {props.dock}
    </div>
  );
}
