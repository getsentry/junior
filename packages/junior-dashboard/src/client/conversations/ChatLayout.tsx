import type { FocusEvent, ReactNode, Ref } from "react";

import { cn } from "../styles";

/** Scroll region padding that goes with `TranscriptColumn`. */
export const transcriptScrollClassName =
  "thin-scrollbar px-4 pb-4 md:px-7 md:pb-6";

/**
 * Center a transcript in the `ChatLayout` scroll region. `full` gives the
 * event log the whole width.
 */
export function TranscriptColumn(props: {
  children: ReactNode;
  className?: string;
  full?: boolean;
}) {
  return (
    <section className="min-w-0">
      <div
        className={cn(
          props.full ? "w-full" : "mx-auto w-full max-w-[52.5rem] pt-5 md:pt-7",
          props.className,
        )}
      >
        {props.children}
      </div>
    </section>
  );
}

// A click on transcript text focuses the scroll region itself. The browser
// then shows `:focus-visible` on the next key press, even a lone Cmd or Shift.
// Mark focus that did not come from the keyboard, so the ring stays hidden.
function markPointerFocus(event: FocusEvent<HTMLDivElement>) {
  const region = event.currentTarget;
  if (event.target !== region || region.matches(":focus-visible")) return;
  region.setAttribute("data-pointer-focus", "");
}

function clearPointerFocus(event: FocusEvent<HTMLDivElement>) {
  // A window switch, such as Cmd+Tab, blurs the region and focuses it again
  // on return. Keep the mark so the ring stays hidden.
  if (event.target !== event.currentTarget || !document.hasFocus()) return;
  event.currentTarget.removeAttribute("data-pointer-focus");
}

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
            "min-h-0 overflow-y-auto overscroll-contain outline-none focus-visible:not-data-pointer-focus:ring-1 focus-visible:ring-inset focus-visible:ring-dashboard-focus",
            props.scrollClassName,
          )}
          data-chat-scroll=""
          ref={props.scrollRef}
          tabIndex={props.scrollAriaLabel ? 0 : undefined}
          onBlur={clearPointerFocus}
          onFocus={markPointerFocus}
        >
          {props.scroll}
        </div>
        {props.overlay}
      </div>
      {props.dock}
    </div>
  );
}
