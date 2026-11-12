import type { ReactNode } from "react";

import { cn } from "../styles";

/**
 * Own reply-thread composer bottom padding and dock chrome.
 *
 * Bottom pad comes only from `--dashboard-composer-dock-padding` written by
 * `VisualViewportShell` / `useMobileViewportHeight`. Callers must not invent
 * `env(safe-area-inset-bottom)` math here.
 *
 * The narrow home docks its create composer in a plain element, so the
 * composer keeps its place in the tree across the breakpoint. It uses
 * `composerDockClass` for the same geometry.
 */
/**
 * Size and pad a narrow-screen composer dock. The bottom pad is the shell's
 * keyboard and safe-area padding.
 */
export const composerDockClass =
  "max-h-[min(calc(var(--dashboard-viewport-height,100dvh)*0.55),24rem)] bg-dashboard-bg px-2 pt-1.5 pb-[var(--dashboard-composer-dock-padding,0.375rem)]";

export function ComposerDock(props: {
  children: ReactNode;
  className?: string;
  /** Queue / authorization chrome above the composer. */
  above?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex w-full min-h-0 shrink-0 flex-col overflow-hidden",
        composerDockClass,
        "md:max-h-none md:overflow-visible md:px-7 md:pt-3 md:pb-5",
        props.className,
      )}
      data-composer-dock=""
    >
      {props.above ? (
        <div className="mx-auto w-full max-w-[52.5rem] min-h-0 min-w-0 shrink overflow-y-auto overscroll-contain md:overflow-visible">
          {props.above}
        </div>
      ) : null}
      <div className="mx-auto w-full max-w-[52.5rem] min-w-0 shrink-0">
        {props.children}
      </div>
    </div>
  );
}
