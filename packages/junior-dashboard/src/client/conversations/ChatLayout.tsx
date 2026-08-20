import type { ReactNode } from "react";

import { cn } from "../styles";

/**
 * Own the conversation chat frame: one scroll region above one dock.
 *
 * Pages pass `scroll` and `dock` only. Do not invent footer padding, safe-area,
 * or shell height math outside this component and `ComposerDock`.
 */
export function ChatLayout(props: {
  className?: string;
  dock?: ReactNode;
  /** When true, keep a taller minimum scroll region for long transcripts. */
  scrollMinTall?: boolean;
  scroll: ReactNode;
  scrollAriaLabel?: string;
  scrollClassName?: string;
}) {
  return (
    <div
      className={cn(
        "grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_minmax(0,auto)]",
        props.scrollMinTall && "grid-rows-[minmax(7rem,1fr)_minmax(0,auto)]",
        props.className,
      )}
    >
      <div
        aria-label={props.scrollAriaLabel}
        className={cn(
          "min-h-0 overflow-y-auto overscroll-contain",
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
