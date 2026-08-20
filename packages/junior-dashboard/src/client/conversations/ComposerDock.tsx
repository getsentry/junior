import type { ReactNode } from "react";

import { cn } from "../styles";

/**
 * Own reply-thread composer bottom padding and dock chrome.
 *
 * Bottom pad comes only from `--dashboard-composer-dock-padding` written by
 * `VisualViewportShell` / `useMobileViewportHeight`. Callers must not invent
 * `env(safe-area-inset-bottom)` math here.
 *
 * Create/empty-state compose is not a dock — keep that layout on the page.
 */
export function ComposerDock(props: {
  children: ReactNode;
  className?: string;
  /** Queue / authorization chrome above the composer. */
  above?: ReactNode;
}) {
  return (
    <div
      className={cn(
        // Shared dock pad is the only bottom geometry owner for reply threads.
        "flex w-full min-h-0 max-h-[min(calc(var(--dashboard-viewport-height,100dvh)*0.55),24rem)] shrink-0 flex-col overflow-hidden bg-[#050507] px-2 pt-1.5 pb-[var(--dashboard-composer-dock-padding,0.375rem)] md:max-h-none md:overflow-visible md:px-7 md:pt-3 md:pb-3",
        props.className,
      )}
      data-composer-dock=""
    >
      {props.above ? (
        <div className="min-h-0 min-w-0 shrink overflow-y-auto overscroll-contain md:overflow-visible">
          {props.above}
        </div>
      ) : null}
      <div className="min-w-0 shrink-0">{props.children}</div>
    </div>
  );
}
